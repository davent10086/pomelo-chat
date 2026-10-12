import { Query } from '../../utils/query';

let running = false;
let timer: ReturnType<typeof setInterval> | undefined;
let ready = false;
let deliver: ((id: number) => Promise<void>) | undefined;
const idle = new Set<() => void>();

/** At-least-once delivery: commit and recovery survive process/Redis failures. */
export const flushMessageOutbox = async (): Promise<void> => {
	if (!ready || running || !deliver) return;
	const handler = deliver;
	running = true;
	try {
		const rows = await Query<Array<{ message_id: number }>>(
			'SELECT message_id FROM message_outbox WHERE delivered_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP ORDER BY message_id LIMIT 100'
		);
		for (const row of rows) {
			if (!ready) break;
			try {
				await handler(row.message_id);
				await Query(
					'UPDATE message_outbox SET delivered_at = CURRENT_TIMESTAMP WHERE message_id = ?',
					[row.message_id]
				);
			} catch (err) {
				console.error('[message:outbox] delivery failed id=%s', row.message_id, err);
				await Query(
					'UPDATE message_outbox SET attempts = attempts + 1, next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL LEAST(60, POW(2, LEAST(attempts, 6))) SECOND) WHERE message_id = ?',
					[row.message_id]
				);
			}
		}
	} catch (err) {
		console.error('[message:outbox] recovery failed:', err);
	} finally {
		running = false;
		for (const resolve of idle) resolve();
		idle.clear();
	}
};

export const startMessageOutbox = (handler: (id: number) => Promise<void>): void => {
	deliver = handler;
};

export const enableMessageOutbox = (): void => {
	if (ready) return;
	ready = true;
	timer = setInterval(() => void flushMessageOutbox(), 2000);
	timer.unref();
};

export const stopMessageOutbox = async () => {
	ready = false;
	if (timer) clearInterval(timer);
	timer = undefined;
	deliver = undefined;
	if (running) await new Promise<void>(resolve => idle.add(resolve));
};
