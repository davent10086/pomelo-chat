export interface CallState {
	id: string;
	room: string;
	type: 'private' | 'group';
	mode: string;
	caller: string;
	members: Record<string, 'invited' | 'joined' | 'left'>;
	status: 'ringing' | 'active' | 'ended';
	expiresAt: number;
	ringUntil: number;
	mediaGeneration?: number;
}
import type { NotificationData } from '../../shared/notification';
import { randomUUID } from 'crypto';
import { better_chat } from '../../infrastructure/redis';
export const createRtcCalls = (dependencies: {
	notifyUser: (data: NotificationData) => Promise<void>;
	revokeMedia: (state: CallState) => Promise<void>;
}) => {
	const NotificationUser = dependencies.notifyUser;

	const deadlines = 'rtc:deadlines';
	const mediaJobs = 'rtc:media-revocations';
	const withCallLease = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
		const key = `rtc:media-lock:${id}`, owner = randomUUID();
		let acquired = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await better_chat.set(key, owner, 'PX', 30000, 'NX')) { acquired = true; break; }
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		if (!acquired) throw new Error('Call busy; retry later');
		let lost = false;
		const heartbeat = setInterval(() => {
			void better_chat.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],30000) end return 0", 1, key, owner)
				.then(result => { if (Number(result) !== 1) lost = true; }).catch(() => { lost = true; });
		}, 10000);
		heartbeat.unref();
		try {
			const result = await work();
			if (lost || await better_chat.get(key) !== owner) throw new Error('Call lease lost');
			return result;
		} finally {
			clearInterval(heartbeat);
			await better_chat.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, owner);
		}
	};
	const reconcileMediaUnlocked = async (id: string): Promise<void> => {
		const pending = await better_chat.hget(mediaJobs, id);
		if (!pending) return;
		const state = JSON.parse(pending) as CallState;
		const watermark = `rtc:media-cleaned:${id}`;
		const current = state.mediaGeneration || 0;
		let generation = Number(await better_chat.get(watermark) || 0);
		const limit = state.status === 'ended' ? current + 1 : current;
		for (; generation < limit; generation++) {
			await dependencies.revokeMedia({ ...state, status: 'ended', mediaGeneration: generation });
			await better_chat.set(watermark, generation + 1, 'EX', 7200);
		}
		// Work is idempotent; only acknowledge this exact snapshot, never a later transition.
		await better_chat.eval("if redis.call('HGET',KEYS[1],ARGV[1]) == ARGV[2] then return redis.call('HDEL',KEYS[1],ARGV[1]) end return 0", 1, mediaJobs, id, pending);
	};
	const reconcileMedia = (id: string) => withCallLease(id, () => reconcileMediaUnlocked(id));
	const reservationScript = `
for i = 2, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 7200)
for i = 2, #KEYS do redis.call('SET', KEYS[i], ARGV[2], 'EX', 60) end
return 1`;
	const createCall = async (
		room: string,
		type: CallState['type'],
		mode: string,
		caller: string,
		invitees: string[]
	): Promise<CallState> => {
		const state: CallState = {
			id: randomUUID(),
			room,
			type,
			mode,
			caller,
			members: Object.fromEntries(
				[caller, ...invitees].map(name => [name, name === caller ? 'joined' : 'invited'])
			),
			status: 'ringing',
			expiresAt: Date.now() + 45000,
			ringUntil: Date.now() + 45000
		};
		const keys = [
			`rtc:call:${state.id}`,
			...Object.keys(state.members).map(name => `rtc:busy:${name}`),
			`rtc:room:${type}:${room}`
		];
		if (
			Number(
				await better_chat.eval(
					reservationScript,
					keys.length,
					...keys,
					JSON.stringify(state),
					state.id
				)
			) !== 1
		)
			throw new Error('Participant busy');
		await better_chat.zadd(deadlines, state.expiresAt, state.id);
		return state;
	};
	const getCall = async (id: string): Promise<CallState | null> => {
		const raw = await better_chat.get(`rtc:call:${id}`);
		return raw ? (JSON.parse(raw) as CallState) : null;
	};
	const getRoomCall = async (type: CallState['type'], room: string): Promise<CallState | null> => {
		const id = await better_chat.get(`rtc:room:${type}:${room}`);
		return id ? getCall(id) : null;
	};
	const transitionCallUnlocked = async (
		id: string,
		user: string,
		action: 'accept' | 'leave' | 'timeout' | 'rejoin'
	): Promise<CallState | null> => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const raw = await better_chat.get(`rtc:call:${id}`);
			if (!raw) return null;
			const state = JSON.parse(raw) as CallState;
			const previousMembership = state.members[user];
			if (!Object.prototype.hasOwnProperty.call(state.members, user))
				throw new Error('Call access denied');
			if (state.status === 'ended') { await reconcileMediaUnlocked(id); return state; }
			if (
				action === 'timeout' &&
				state.expiresAt > Date.now() &&
				(state.ringUntil > Date.now() || !Object.values(state.members).includes('invited'))
			)
				return state;
			if (action === 'timeout') {
				if (state.expiresAt <= Date.now() || state.status === 'ringing') state.status = 'ended';
				else
					for (const name of Object.keys(state.members))
						if (state.members[name] === 'invited') state.members[name] = 'left';
			} else if (action === 'accept' || action === 'rejoin') {
				if (
					(action === 'rejoin'
						? state.type !== 'group' || state.status !== 'active' || state.members[user] !== 'left'
						: state.members[user] === 'left') ||
					state.expiresAt <= Date.now() ||
					(state.members[user] === 'invited' && state.ringUntil <= Date.now())
				)
					throw new Error('Call expired');
				state.members[user] = 'joined';
				state.status = 'active';
				state.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
			} else {
				state.members[user] = 'left';
				if (
					state.type === 'private' ||
					(user === state.caller && state.status === 'ringing') ||
					!Object.values(state.members).includes('joined')
				)
					state.status = 'ended';
				else if (state.status === 'ringing' && !Object.values(state.members).includes('invited'))
					state.status = 'ended';
			}
			// OSS LiveKit cannot revoke an issued JWT. Retire the entire media room so
			// departed users cannot replay a token while the remaining group continues.
			if (state.status !== 'ended' && state.type === 'group' && previousMembership === 'joined' && state.members[user] === 'left')
				state.mediaGeneration = (state.mediaGeneration || 0) + 1;
			const names = Object.keys(state.members);
			const script = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[5] == 'rejoin' then
 local busy=redis.call('GET',KEYS[tonumber(ARGV[6])])
 if busy and busy ~= ARGV[3] then return -1 end
end
local roomIndex=#KEYS-1
redis.call('SET',KEYS[1],ARGV[2],'EX',7200)
local state=cjson.decode(ARGV[2]); local names=cjson.decode(ARGV[4]);
for i = 2,roomIndex-1 do
 local name=names[i-1]
 if state.status == 'ended' or state.members[name] == 'left' then
  if redis.call('GET',KEYS[i]) == ARGV[3] then redis.call('DEL',KEYS[i]) end
 elseif state.members[name] == 'joined' then redis.call('SET',KEYS[i],ARGV[3],'EX',7200) end
end
if state.status == 'ended' then
 if redis.call('GET',KEYS[roomIndex]) == ARGV[3] then redis.call('DEL',KEYS[roomIndex]) end
else redis.call('SET',KEYS[roomIndex],ARGV[3],'EX',7200) end
redis.call('HSET',KEYS[#KEYS],ARGV[3],ARGV[2])
return 1`;
			const keys = [
				`rtc:call:${id}`,
				...names.map(name => `rtc:busy:${name}`),
				`rtc:room:${state.type}:${state.room}`
			];
			if (
				Number(
					await better_chat.eval(
						script,
						keys.length + 1,
						...keys,
						mediaJobs,
						raw,
						JSON.stringify(state),
						id,
						JSON.stringify(names),
						action,
						names.indexOf(user) + 2
					)
				) !== 1
			)
				continue;
			if (state.status === 'ended') await better_chat.zrem(deadlines, id);
			else
				await better_chat.zadd(
					deadlines,
					Object.values(state.members).includes('invited')
						? Math.min(state.ringUntil, state.expiresAt)
						: state.expiresAt,
					id
				);
			await Promise.all(
				names.map(name =>
					NotificationUser({
						receiver_username: name,
						name: 'call_state',
						callId: id,
						room: state.room,
						status: state.status,
						memberStatus: state.members[name],
						action,
						user,
						mediaGeneration: state.mediaGeneration || 0
					})
				)
			).catch(err => console.error('[rtc] state notification:', err));
			await reconcileMediaUnlocked(id);
			return state;
		}
		throw new Error('Call transition conflict');
	};
	const transitionCall = (id: string, user: string, action: 'accept' | 'leave' | 'timeout' | 'rejoin') =>
		withCallLease(id, () => transitionCallUnlocked(id, user, action));
	let expiring: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let presenceOffset = 0;
	let mediaCursor = '0';
	const startCallTimeouts = () => {
		if (timer) return;
		timer = setInterval(() => {
			if (expiring) return;
			expiring = better_chat
				.zrangebyscore(deadlines, 0, Date.now(), 'LIMIT', 0, 100)
				.then(async ids => {
					const jobs = await better_chat.hscan(mediaJobs, mediaCursor, 'COUNT', 20);
					mediaCursor = jobs[0];
					for (let index = 0; index < jobs[1].length; index += 2) {
						if (!timer) break;
						await reconcileMedia(jobs[1][index]).catch(err => console.error('[rtc] media recovery:', err));
					}
					for (const id of ids) {
						if (!timer) break;
						const state = await getCall(id);
						if (state) await transitionCall(id, state.caller, 'timeout');
						else await better_chat.zrem(deadlines, id);
					}
					// Sweep a bounded page of live calls too: server crashes and half-open sockets
					// must not keep users busy until the two-hour call deadline.
					const live = await better_chat.zrange(deadlines, presenceOffset, presenceOffset + 49);
					presenceOffset = live.length < 50 ? 0 : presenceOffset + 50;
					for (const id of live) {
						if (!timer) break;
						const state = await getCall(id);
						if (!state || state.status === 'ended') continue;
						for (const [name, status] of Object.entries(state.members)) {
							if (status === 'joined' && !(await better_chat.exists(`presence:${name}`)))
								await transitionCall(id, name, 'leave');
						}
					}
				})
				.catch(err => console.error('[rtc] timeout recovery:', err))
				.finally(() => {
					expiring = undefined;
				});
		}, 1000);
		timer.unref();
	};
	const stopCallTimeouts = async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		await expiring;
	};
	const releaseUserCall = async (username: string): Promise<void> => {
		const id = await better_chat.get(`rtc:busy:${username}`);
		if (id && (await getCall(id))) await transitionCall(id, username, 'leave');
	};
	return {
		createCall,
		getCall,
		getRoomCall,
		transitionCall,
		reconcileMedia,
		withCallLease,
		startCallTimeouts,
		stopCallTimeouts,
		releaseUserCall
	};
};

export type RtcCalls = ReturnType<typeof createRtcCalls>;
