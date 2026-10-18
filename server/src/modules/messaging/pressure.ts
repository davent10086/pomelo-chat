import * as repository from './repository';
import { consumeTokenBuckets } from '../../infrastructure/token-bucket';
import { countMessageMetric, setMessageGauge } from '../../infrastructure/message-metrics';
import { MessageOverloadError, positiveSetting } from '../../shared/overload';

interface PressureRow {
	conversationId: number;
	pending: number;
	oldestSeconds: number;
}
let timer: ReturnType<typeof setInterval> | undefined;
let flight: Promise<void> | undefined;
let snapshot:
	{ at: number; pending: number; oldest: number; rooms: Map<number, PressureRow> } | undefined;
export const refreshMessagePressure = (): Promise<void> => {
	if (flight) return flight;
	flight = (async () => {
		try {
			const rows = await repository.loadOutboxPressure<PressureRow[]>();
			const pending = rows.reduce((sum, row) => sum + Number(row.pending), 0);
			const oldest = rows.reduce((max, row) => Math.max(max, Number(row.oldestSeconds)), 0);
			snapshot = {
				at: Date.now(),
				pending,
				oldest,
				rooms: new Map(rows.map(row => [Number(row.conversationId), row]))
			};
			setMessageGauge('pomelo_outbox_pending', pending);
			setMessageGauge('pomelo_outbox_oldest_seconds', oldest);
			setMessageGauge(
				'pomelo_outbox_largest_room_pending',
				rows.reduce((max, row) => Math.max(max, Number(row.pending)), 0)
			);
			setMessageGauge('pomelo_outbox_sample_timestamp_seconds', snapshot.at / 1000);
			setMessageGauge('pomelo_outbox_sample_healthy', 1);
		} catch (error) {
			setMessageGauge('pomelo_outbox_sample_healthy', 0);
			countMessageMetric('pomelo_outbox_sample_errors_total');
			throw error;
		}
	})().finally(() => {
		flight = undefined;
	});
	return flight;
};
export const startMessagePressure = async (): Promise<void> => {
	await refreshMessagePressure();
	if (!timer) {
		timer = setInterval(() => void refreshMessagePressure().catch(() => undefined), 2000);
		timer.unref();
	}
};
export const stopMessagePressure = async (): Promise<void> => {
	if (timer) clearInterval(timer);
	timer = undefined;
	await flight?.catch(() => undefined);
	snapshot = undefined;
};
export const admitMessage = async (
	userId: number | string,
	room: string,
	type: 'private' | 'group',
	conversationId?: number
): Promise<void> => {
	try {
		// Sampled early gate, not a strict durable queue-length reservation.
		if (timer && (!snapshot || Date.now() - snapshot.at > 10000))
			throw new MessageOverloadError('pressure_unavailable');
		if (timer && snapshot) {
			const local = conversationId === undefined ? undefined : snapshot.rooms.get(conversationId);
			if (
				snapshot.pending >= positiveSetting('MESSAGE_OUTBOX_MAX_PENDING', 500) ||
				(local &&
					Number(local.pending) >= positiveSetting('MESSAGE_OUTBOX_ROOM_MAX_PENDING', 40)) ||
				(local &&
					Number(local.oldestSeconds) >= positiveSetting('MESSAGE_OUTBOX_MAX_AGE_SECONDS', 3))
			)
				throw new MessageOverloadError('outbox_pressure', 2000);
		}
		const retry = await consumeTokenBuckets([
			{
				key: `message:{admission}:user:${userId}`,
				rate: positiveSetting('MESSAGE_USER_RATE', 5),
				capacity: positiveSetting('MESSAGE_USER_BURST', 10)
			},
			{
				key: `message:{admission}:room:${room}`,
				rate: positiveSetting(
					type === 'group' ? 'MESSAGE_GROUP_RATE' : 'MESSAGE_PRIVATE_RATE',
					type === 'group' ? 20 : 10
				),
				capacity: positiveSetting(
					type === 'group' ? 'MESSAGE_GROUP_BURST' : 'MESSAGE_PRIVATE_BURST',
					20
				)
			},
			{
				key: 'message:{admission}:global',
				rate: positiveSetting('MESSAGE_GLOBAL_RATE', 150),
				capacity: positiveSetting('MESSAGE_GLOBAL_BURST', 100)
			}
		]);
		if (retry > 0) throw new MessageOverloadError('rate_limit', retry);
	} catch (error) {
		const failure =
			error instanceof MessageOverloadError
				? error
				: new MessageOverloadError('admission_unavailable', 2000);
		countMessageMetric(`pomelo_message_rejected_${failure.reason}_total`);
		throw failure;
	}
};
