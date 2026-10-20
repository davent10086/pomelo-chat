export interface CreateJoinTokenInput {
	room?: unknown;
	type?: unknown;
	callId?: unknown;
}
export interface InviteInput {
	room?: unknown;
	type?: unknown;
	mode?: unknown;
}
export interface AcceptCallInput {
	callId?: unknown;
}
export interface EndCallInput {
	callId?: unknown;
}
import { authorizeChatRoom } from '../social/public';
import { getRtcRecipients as getRecipients } from '../../read-models/rtc-recipients';
import type { RtcCalls } from './calls';
import type { NotificationData } from '../../shared/notification';
import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
import { issueJoinToken } from './livekit-adapter';
import { CommonStatus } from '../../shared/status';
import { better_chat } from '../../infrastructure/redis';
export const createRtcApplication = (dependencies: {
	calls: RtcCalls;
	notifyUser: (data: NotificationData) => Promise<void>;
}) => {
	const { createCall, getCall, getRoomCall, transitionCall } = dependencies.calls;
	const NotificationUser = dependencies.notifyUser;
	type ChatType = 'private' | 'group';
	const MAX_PARTICIPANTS = 20;

	const isChatType = (value: unknown): value is ChatType =>
		value === 'private' || value === 'group';
	const currentCall = async (actor: Actor): Promise<Outcome> => {
		try {
			const id = await better_chat.get(`rtc:busy:${actor.username}`);
			const state = id ? await getCall(id) : null;
			if (
				!state ||
				state.status === 'ended' ||
				state.members[actor.username] !== 'invited' ||
				state.ringUntil <= Date.now()
			)
				return success({ call: null });
			if (!(await authorizeChatRoom(actor.id, state.room, state.type)))
				return failure(CommonStatus.UNAUTHORIZED);
			const recipients = await getRecipients(actor.id, state.room, state.type);
			return success({
				call: {
					callId: state.id,
					room: state.room,
					mode: state.mode,
					callReceiverList: recipients.filter(
						item => item.username in state.members && state.members[item.username] !== 'left'
					)
				}
			});
		} catch {
			return failure(CommonStatus.CONNECTION_ERR);
		}
	};
	const createJoinToken = async (
		actor: Actor,
		parameters: CreateJoinTokenInput
	): Promise<Outcome> => {
		const { room, type, callId } = parameters || {};
		if (typeof room !== 'string' || !room || !isChatType(type) || !actor)
			return failure(CommonStatus.PARAM_ERR);
		try {
			if (!(await authorizeChatRoom(actor.id, room, type)))
				return failure(CommonStatus.UNAUTHORIZED);
			const state = typeof callId === 'string' ? await getCall(callId) : null;
			if (
				!state ||
				state.room !== room ||
				state.type !== type ||
				state.status === 'ended' ||
				state.expiresAt <= Date.now() ||
				state.members[actor.username] !== 'joined'
			)
				return failure(CommonStatus.UNAUTHORIZED);
			return success(await issueJoinToken(actor, room, type, state.id));
		} catch (error) {
			console.error('[rtc] create join token failed:', error);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const invite = async (actor: Actor, parameters: InviteInput): Promise<Outcome> => {
		const { room, type, mode } = parameters || {};
		if (
			typeof room !== 'string' ||
			!room ||
			!isChatType(type) ||
			typeof mode !== 'string' ||
			!actor
		)
			return failure(CommonStatus.PARAM_ERR);
		if (
			!['private_audio', 'private_video', 'group_audio', 'group_video'].includes(mode) ||
			!mode.startsWith(type)
		)
			return failure(CommonStatus.PARAM_ERR);
		try {
			if (!(await authorizeChatRoom(actor.id, room, type)))
				return failure(CommonStatus.UNAUTHORIZED);
			if (!(await better_chat.get(`presence:${actor.username}`)))
				return failure(CommonStatus.CONNECTION_ERR);
			const recipients = await getRecipients(actor.id, room, type);
			const ongoing = type === 'group' ? await getRoomCall(type, room) : null;
			if (
				ongoing?.status === 'active' &&
				ongoing.mode === mode &&
				ongoing.members[actor.username] === 'left'
			) {
				const resumed = await transitionCall(ongoing.id, actor.username, 'rejoin');
				if (!resumed || resumed.status !== 'active') return failure(CommonStatus.NOT_FOUND);
				return success({
					callId: resumed.id,
					recipients: recipients.filter(item => resumed.members[item.username] === 'joined'),
					expiresAt: resumed.expiresAt
				});
			}
			const candidates = await Promise.all(
				recipients.map(async item => ({
					item,
					online: !!(await better_chat.get(`presence:${item.username}`)),
					busy: !!(await better_chat.get(`rtc:busy:${item.username}`))
				}))
			);
			const online = candidates
				.filter(c => c.online && !c.busy)
				.slice(0, MAX_PARTICIPANTS - 1)
				.map(c => c.item);
			if (!online.length) return failure(CommonStatus.NOT_FOUND);
			const state = await createCall(
				room,
				type,
				mode,
				actor.username,
				online.map(item => item.username)
			);
			await Promise.all(
				online.map(item =>
					NotificationUser({
						receiver_username: item.username,
						name: 'create_room',
						callId: state.id,
						room,
						mode,
						callReceiverList: recipients
							.filter(peer => peer.username !== item.username)
							.concat([{ username: actor.username, alias: actor.name || actor.username }])
					})
				)
			);
			return success({ callId: state.id, recipients: online, expiresAt: state.expiresAt });
		} catch (error) {
			console.error('[rtc] invite failed:', error);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const acceptCall = async (actor: Actor, parameters: AcceptCallInput): Promise<Outcome> => {
		try {
			const existing =
				typeof parameters.callId === 'string' ? await getCall(parameters.callId) : null;
			if (!existing) return failure(CommonStatus.NOT_FOUND);
			if (!(await authorizeChatRoom(actor.id, existing.room, existing.type)))
				return failure(CommonStatus.UNAUTHORIZED);
			const state = await transitionCall(existing.id, actor.username, 'accept');
			if (!state || state.status === 'ended') return failure(CommonStatus.NOT_FOUND);
			if (!(await authorizeChatRoom(actor.id, state.room, state.type))) {
				await transitionCall(state.id, actor.username, 'leave');
				return failure(CommonStatus.UNAUTHORIZED);
			}
			return success({ callId: state.id, status: state.status });
		} catch (err) {
			console.error('[rtc] accept:', err);
			return failure(CommonStatus.UNAUTHORIZED);
		}
	};
	const endCall = async (actor: Actor, parameters: EndCallInput): Promise<Outcome> => {
		try {
			const state = await transitionCall(String(parameters.callId || ''), actor.username, 'leave');
			return success({ ended: true, status: state?.status || 'ended' });
		} catch (err) {
			console.error('[rtc] end:', err);
			return failure(CommonStatus.UNAUTHORIZED);
		}
	};
	return { createJoinToken, invite, acceptCall, endCall, currentCall };
};
