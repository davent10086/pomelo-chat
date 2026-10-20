import * as repository from './repository';
import { randomUUID } from 'crypto';
import { withTransaction } from '../../infrastructure/database-query';
import { countMessageMetric, setMessageGauge } from '../../infrastructure/message-metrics';
import { boundedInteger } from '../../shared/validation';
import type { OutboxDeliveryContext } from './contracts';

const LEASE_SECONDS = 60;
const CONCURRENCY = 8;
type DeliveryHandler = (id: number, context: OutboxDeliveryContext) => Promise<void>;
const positiveMilliseconds = (value: unknown, fallback: number): number =>
	Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

const bounded = async (work: Promise<unknown>, milliseconds: number): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work,
			new Promise<void>(resolve => {
				timer = setTimeout(resolve, milliseconds);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

/** At-least-once delivery. Only each room's oldest pending message may be claimed. */
export class MessageOutboxWorker {
	private active = false;
	private inFlight?: Promise<void>;
	private requested = false;
	private nextMaintenance = Date.now() + 60000;
	private timer?: ReturnType<typeof setInterval>;
	private readonly controllers = new Set<AbortController>();
	private readonly deliveryTimeoutMs: number;
	private readonly shutdownTimeoutMs: number;

	constructor(
		private readonly deliver: DeliveryHandler,
		options: { deliveryTimeoutMs?: number; shutdownTimeoutMs?: number } = {}
	) {
		this.deliveryTimeoutMs = positiveMilliseconds(
			options.deliveryTimeoutMs ?? process.env.MESSAGE_OUTBOX_DELIVERY_TIMEOUT_MS,
			45000
		);
		this.shutdownTimeoutMs = positiveMilliseconds(options.shutdownTimeoutMs, 5000);
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.timer = setInterval(() => void this.flush(), 2000);
		this.timer.unref();
	}

	flush(): Promise<void> {
		if (!this.active) return Promise.resolve();
		this.requested = true;
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.drainRequested().finally(() => {
			this.inFlight = undefined;
			// A write can arrive after a lane's empty snapshot but before this drain ends.
			// Preserve that wake-up rather than making it wait for the periodic poll.
			if (this.active && this.requested) return this.flush();
		});
		return this.inFlight;
	}

	private async drainRequested(): Promise<void> {
		do {
			this.requested = false;
			await this.drain();
		} while (this.active && this.requested);
	}

	private async drain(): Promise<void> {
		if (Date.now() >= this.nextMaintenance) {
			this.nextMaintenance = Date.now() + 60000;
			try {
				await repository.pruneDeliveredOutbox(boundedInteger('MESSAGE_OUTBOX_RETENTION_DAYS', 7));
				setMessageGauge('pomelo_outbox_failed', Number((await repository.countFailedOutbox())[0]?.total || 0));
			} catch (error) { console.error('[message:outbox] maintenance:', error); }
		}
		await Promise.all(Array.from({ length: CONCURRENCY }, () => this.drainLane()));
	}

	private async drainLane(): Promise<void> {
		try {
			while (this.active) {
				const token = randomUUID();
				const rows = await withTransaction(async query => {
					const pending = await repository.lockAvailableOutboxHead<Array<{ message_id: number }>>(
						[1],
						query
					);
					if (pending.length)
						await repository.claimOutboxRows(
							[token, LEASE_SECONDS, pending.map(row => row.message_id)],
							query
						);
					return pending;
				});
				if (!rows.length) break;
				await this.deliverClaim(rows[0].message_id, token);
			}
		} catch (error) {
			console.error('[message:outbox] recovery failed:', error);
		}
	}

	private async deliverClaim(id: number, token: string): Promise<void> {
		const controller = new AbortController();
		this.controllers.add(controller);
		let deadline = performance.now() + LEASE_SECONDS * 1000;
		let renewal: Promise<void> | undefined;
		const loseLease = () => {
			const error = new Error('Outbox lease lost');
			controller.abort(error);
			return error;
		};
		const checkActive = () => {
			if (!this.active) controller.abort(new Error('Outbox stopping'));
			if (performance.now() >= deadline) loseLease();
			controller.signal.throwIfAborted();
		};
		const assertLease = (): Promise<void> => {
			checkActive();
			return (renewal ||= (async () => {
				const started = performance.now();
				try {
					const result = await repository.renewOutboxLease<{ affectedRows: number }>([
						LEASE_SECONDS,
						id,
						token
					]);
					checkActive();
					if (result.affectedRows !== 1) throw loseLease();
					// Conservative deadline: time spent waiting for SQL never extends local authority.
					deadline = started + LEASE_SECONDS * 1000;
					checkActive();
				} catch (error) {
					controller.abort(error);
					throw error;
				}
			})().finally(() => {
				renewal = undefined;
			}));
		};
		let onAbort: () => void = () => undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(controller.signal.reason);
			controller.signal.addEventListener('abort', onAbort, { once: true });
		});
		const timeout = setTimeout(
			() => controller.abort(new Error('Outbox delivery timed out')),
			this.deliveryTimeoutMs
		);
		const heartbeat = setInterval(
			() => {
				void Promise.resolve()
					.then(assertLease)
					.catch(error => controller.abort(error));
			},
			(LEASE_SECONDS * 1000) / 3
		);
		heartbeat.unref();
		try {
			await Promise.race([
				aborted,
				(async () => {
					await assertLease();
					await this.deliver(id, { signal: controller.signal, checkActive, assertLease });
					await assertLease();
					const result = await repository.completeOutboxClaim<{ affectedRows: number }>([
						id,
						token
					]);
					if (result.affectedRows !== 1) throw loseLease();
					countMessageMetric('pomelo_outbox_dispatch_completed_total');
				})()
			]);
		} catch (error) {
			controller.abort(error);
			console.error('[message:outbox] delivery failed id=%s', id, error);
			countMessageMetric('pomelo_outbox_dispatch_errors_total');
			await bounded(
				repository.retryOutboxClaim([id, token]).catch(retryError => {
					console.error('[message:outbox] retry scheduling failed:', retryError);
				}),
				this.shutdownTimeoutMs
			);
		} finally {
			clearInterval(heartbeat);
			clearTimeout(timeout);
			controller.signal.removeEventListener('abort', onAbort);
			this.controllers.delete(controller);
		}
	}

	async stop(): Promise<void> {
		this.active = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const controller of this.controllers) controller.abort(new Error('Outbox stopping'));
		await bounded(this.inFlight || Promise.resolve(), this.shutdownTimeoutMs);
	}
}

let worker: MessageOutboxWorker | undefined;
export const startMessageOutbox = (handler: DeliveryHandler): void => {
	worker = new MessageOutboxWorker(handler);
};
export const enableMessageOutbox = (): void => worker?.start();
export const flushMessageOutbox = (): Promise<void> => worker?.flush() || Promise.resolve();
export const stopMessageOutbox = async (): Promise<void> => {
	await worker?.stop();
	worker = undefined;
};
