import type { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { better_chat } from '../../infrastructure/redis';
import { boundedInteger } from '../../shared/validation';

const userLimit = boundedInteger('MAX_CHAT_CONNECTIONS_PER_USER', 8, 1, 100);
const roomLimit = boundedInteger('MAX_CHAT_CONNECTIONS_PER_ROOM', 3, 1, 100);
const leaseMs = 45000;
const acquire = `
for i=1,2 do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',ARGV[1]) end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) or redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[5]) then return 0 end
for i=1,2 do
 redis.call('ZADD',KEYS[i],ARGV[2],ARGV[3]); redis.call('PEXPIRE',KEYS[i],90000)
end
return 1`;
const renew = `
for i=1,2 do
 local expiry=redis.call('ZSCORE',KEYS[i],ARGV[1])
 if not expiry or tonumber(expiry)<=tonumber(ARGV[2]) then return 0 end
end
for i=1,2 do redis.call('ZADD',KEYS[i],ARGV[3],ARGV[1]); redis.call('PEXPIRE',KEYS[i],90000) end
return 1`;

/** Shared admission across server instances; a lost lease may never keep a live socket. */
export const admitChatSocket = async (ws: WebSocket, userId: string, room: string): Promise<boolean> => {
	const keys = [`chat:connections:${userId}`, `chat:connections:${userId}:${room}`];
	const member = randomUUID();
	const now = Date.now();
	if (Number(await better_chat.eval(acquire, 2, ...keys, now, now + leaseMs, member, userLimit, roomLimit)) !== 1)
		return false;
	let stopped = false;
	let renewing = false;
	const release = () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		void better_chat.eval("for i=1,2 do redis.call('ZREM',KEYS[i],ARGV[1]) end return 1", 2, ...keys, member)
			.catch(error => console.error('[chat] lease release:', error));
	};
	const timer = setInterval(() => {
		if (renewing || stopped) return;
		renewing = true;
		const time = Date.now();
		void better_chat.eval(renew, 2, ...keys, member, time, time + leaseMs)
			.then(result => { if (Number(result) !== 1) { ws.close(4004, 'connection lease lost'); release(); } })
			.catch(() => { ws.close(4004, 'connection lease unavailable'); release(); })
			.finally(() => { renewing = false; });
	}, 15000);
	timer.unref();
	ws.once('close', release);
	if (ws.readyState !== 1) { release(); return false; }
	return true;
};
