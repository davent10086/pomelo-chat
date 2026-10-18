import * as repository from './repository';
import { randomUUID } from 'crypto';
import { withTransaction } from '../../infrastructure/database-query';
import { countMessageMetric } from '../../infrastructure/message-metrics';

const LEASE_SECONDS = 60;
const CONCURRENCY = 8;

/** At-least-once delivery. Only each room's oldest pending message may be claimed. */
export class MessageOutboxWorker {
	private active = false;
	private inFlight?: Promise<void>;
	private requested = false;
	private timer?: ReturnType<typeof setInterval>;

	constructor(private readonly deliver: (id: number) => Promise<void>) {}

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
		let renewal = Promise.resolve();
		const heartbeat = setInterval(
			() => {
				renewal = renewal
					.then(async () => {
						await repository.renewOutboxLease([LEASE_SECONDS, id, token]);
					})
					.catch(error => console.error('[message:outbox] lease renewal failed:', error));
			},
			(LEASE_SECONDS * 1000) / 3
		);
		heartbeat.unref();
		try {
			await this.deliver(id);
			clearInterval(heartbeat);
			await renewal;
			await repository.completeOutboxClaim([id, token]);
			countMessageMetric('pomelo_outbox_dispatch_completed_total');
		} catch (error) {
			clearInterval(heartbeat);
			await renewal;
			console.error('[message:outbox] delivery failed id=%s', id, error);
			countMessageMetric('pomelo_outbox_dispatch_errors_total');
			await repository.retryOutboxClaim([id, token]);
		} finally {
			clearInterval(heartbeat);
		}
	}

	async stop(): Promise<void> {
		this.active = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.inFlight;
	}
}

let worker: MessageOutboxWorker | undefined;
export const startMessageOutbox = (handler: (id: number) => Promise<void>): void => {
	worker = new MessageOutboxWorker(handler);
};
export const enableMessageOutbox = (): void => worker?.start();
export const flushMessageOutbox = (): Promise<void> => worker?.flush() || Promise.resolve();
export const stopMessageOutbox = async (): Promise<void> => {
	await worker?.stop();
	worker = undefined;
};
