import { better_chat } from '../../infrastructure/redis';
import type { FanoutPayload } from '../messaging/contracts';

// Do not queue a timed-out worker's publish for replay after Redis reconnects.
export const fanoutPublisher = better_chat.duplicate({
	enableOfflineQueue: false,
	maxRetriesPerRequest: 0,
	commandTimeout: 5000
});
fanoutPublisher.on('error', error => console.error('[message] publisher:', error.message));

// The sequence check and PUBLISH are one Redis operation. Equal sequences may be
// retried (at-least-once); an old worker cannot publish seq 1 after seq 2.
const ORDERED_PUBLISH = `
local previous = redis.call('GET', KEYS[1])
if previous and tonumber(previous) > tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PUBLISH', ARGV[2], ARGV[3])
return 1`;

export const publishFanout = async (channel: string, payload: FanoutPayload): Promise<boolean> => {
	if (fanoutPublisher.status !== 'ready') throw new Error('Message publisher unavailable');
	const raw = JSON.stringify(payload);
	if ('name' in payload.message) {
		await fanoutPublisher.publish(channel, raw);
		return true;
	}
	const sequence = payload.message.room_seq;
	if (!Number.isSafeInteger(sequence) || Number(sequence) < 1)
		throw new Error('Invalid fanout sequence');
	return (
		Number(
			await fanoutPublisher.eval(
				ORDERED_PUBLISH,
				1,
				`pomelo:message:fanout-sequence:${payload.room}`,
				String(sequence),
				channel,
				raw
			)
		) === 1
	);
};
