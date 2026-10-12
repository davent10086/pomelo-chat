import { randomUUID } from 'crypto';
import { better_chat } from '../../utils/authenticate';
import { NotificationUser } from '../../utils/notification';

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
}
const deadlines = 'rtc:deadlines';
const reservationScript = `
for i = 2, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 7200)
for i = 2, #KEYS do redis.call('SET', KEYS[i], ARGV[2], 'EX', 60) end
return 1`;

export const createCall = async (
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
		...Object.keys(state.members).map(name => `rtc:busy:${name}`)
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

export const getCall = async (id: string): Promise<CallState | null> => {
	const raw = await better_chat.get(`rtc:call:${id}`);
	return raw ? (JSON.parse(raw) as CallState) : null;
};

/** Lua CAS makes simultaneous accept/end/reject deterministic across servers. */
export const transitionCall = async (
	id: string,
	user: string,
	action: 'accept' | 'leave' | 'timeout'
): Promise<CallState | null> => {
	for (let attempt = 0; attempt < 5; attempt++) {
		const raw = await better_chat.get(`rtc:call:${id}`);
		if (!raw) return null;
		const state = JSON.parse(raw) as CallState;
		if (!Object.prototype.hasOwnProperty.call(state.members, user))
			throw new Error('Call access denied');
		if (state.status === 'ended') return state;
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
		} else if (action === 'accept') {
			if (
				state.members[user] === 'left' ||
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
		const names = Object.keys(state.members);
		const script = `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2],'EX',7200)
local state=cjson.decode(ARGV[2]); local names=cjson.decode(ARGV[4]);
for i = 2,#KEYS do
 local name=names[i-1]
 if state.status == 'ended' or state.members[name] == 'left' then
  if redis.call('GET',KEYS[i]) == ARGV[3] then redis.call('DEL',KEYS[i]) end
 elseif state.members[name] == 'joined' then redis.call('SET',KEYS[i],ARGV[3],'EX',7200) end
end return 1`;
		const keys = [`rtc:call:${id}`, ...names.map(name => `rtc:busy:${name}`)];
		if (
			Number(
				await better_chat.eval(
					script,
					keys.length,
					...keys,
					raw,
					JSON.stringify(state),
					id,
					JSON.stringify(names)
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
					user
				})
			)
		).catch(err => console.error('[rtc] state notification:', err));
		return state;
	}
	throw new Error('Call transition conflict');
};

let expiring: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
export const startCallTimeouts = () => {
	if (timer) return;
	timer = setInterval(() => {
		if (expiring) return;
		expiring = better_chat
			.zrangebyscore(deadlines, 0, Date.now(), 'LIMIT', 0, 100)
			.then(async ids => {
				for (const id of ids) {
					if (!timer) break;
					const state = await getCall(id);
					if (state) await transitionCall(id, state.caller, 'timeout');
					else await better_chat.zrem(deadlines, id);
				}
			})
			.catch(err => console.error('[rtc] timeout recovery:', err))
			.finally(() => {
				expiring = undefined;
			});
	}, 1000);
	timer.unref();
};
export const stopCallTimeouts = async () => {
	if (timer) clearInterval(timer);
	timer = undefined;
	await expiring;
};
