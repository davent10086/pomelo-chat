import type { Request, Response } from 'express';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

import { CommonStatus } from '../../utils/status';
import { RespData, RespError } from '../../utils/resp';
import { Query } from '../../utils/query';
import { better_chat } from '../../utils/authenticate';
import { createCall, getCall, transitionCall } from './calls';
import { NotificationUser } from '../../utils/notification';

type ChatType = 'private' | 'group';
const MAX_PARTICIPANTS = 20;
const TOKEN_TTL_SECONDS = 10 * 60;
interface RtcRecipient {
	username: string;
	avatar?: string | null;
	alias?: string | null;
}

const isChatType = (value: unknown): value is ChatType => value === 'private' || value === 'group';
const roomName = (type: ChatType, room: string) => `pomelo-${type}-${room}`;
const canAccessRoom = async (
	userId: number | string,
	room: string,
	type: ChatType
): Promise<boolean> => {
	const sql =
		type === 'group'
			? 'SELECT 1 FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id WHERE gc.room = ? AND gm.user_id = ? LIMIT 1'
			: 'SELECT 1 FROM friend f JOIN friend_group fg ON fg.id = f.group_id WHERE f.room = ? AND fg.user_id = ? LIMIT 1';
	return (await Query<unknown[]>(sql, [room, userId])).length > 0;
};
const getRecipients = async (
	userId: number | string,
	room: string,
	type: ChatType
): Promise<RtcRecipient[]> => {
	const sql =
		type === 'group'
			? 'SELECT u.username, u.avatar, u.name AS alias FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id JOIN user u ON u.id = gm.user_id WHERE gc.room = ? AND gm.user_id <> ?'
			: 'SELECT u.username, u.avatar, f.remark AS alias FROM friend f JOIN friend_group fg ON fg.id = f.group_id JOIN user u ON u.username = f.username WHERE f.room = ? AND fg.user_id = ?';
	return Query<RtcRecipient[]>(sql, [room, userId]);
};
const liveKitConfig = () => ({
	apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
	apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
	serverUrl: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
	httpUrl: process.env.LIVEKIT_HTTP_URL || 'http://127.0.0.1:7880'
});

/** Issue a room-scoped, short-lived LiveKit token after authorizing chat membership. */
export const createJoinToken = async (req: Request, res: Response): Promise<void> => {
	const { room, type, callId } = req.body || {};
	if (typeof room !== 'string' || !room || !isChatType(type) || !req.user)
		return RespError(res, CommonStatus.PARAM_ERR);
	try {
		if (!(await canAccessRoom(req.user.id, room, type)))
			return RespError(res, CommonStatus.UNAUTHORIZED);
		const state = typeof callId === 'string' ? await getCall(callId) : null;
		if (
			!state ||
			state.room !== room ||
			state.type !== type ||
			state.status === 'ended' ||
			state.expiresAt <= Date.now() ||
			state.members[req.user.username] !== 'joined'
		)
			return RespError(res, CommonStatus.UNAUTHORIZED);
		const config = liveKitConfig();
		const liveKitRoom = roomName(type, `${room}-${state.id}`);
		const service = new RoomServiceClient(config.httpUrl, config.apiKey, config.apiSecret);
		try {
			await service.createRoom({
				name: liveKitRoom,
				maxParticipants: MAX_PARTICIPANTS,
				emptyTimeout: 60,
				departureTimeout: 30
			});
		} catch (error) {
			if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
		}

		const token = new AccessToken(config.apiKey, config.apiSecret, {
			identity: req.user.username,
			ttl: TOKEN_TTL_SECONDS,
			name: req.user.name || req.user.username
		});
		token.addGrant({
			roomJoin: true,
			room: liveKitRoom,
			canPublish: true,
			canSubscribe: true,
			canPublishData: false
		});
		RespData(res, {
			serverUrl: config.serverUrl,
			roomName: liveKitRoom,
			token: await token.toJwt(),
			identity: req.user.username,
			expiresIn: TOKEN_TTL_SECONDS
		});
	} catch (error) {
		console.error('[rtc] create join token failed:', error);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

/** Send application-level invitations; LiveKit handles all media signaling. */
export const invite = async (req: Request, res: Response): Promise<void> => {
	const { room, type, mode } = req.body || {};
	if (
		typeof room !== 'string' ||
		!room ||
		!isChatType(type) ||
		typeof mode !== 'string' ||
		!req.user
	)
		return RespError(res, CommonStatus.PARAM_ERR);
	if (
		!['private_audio', 'private_video', 'group_audio', 'group_video'].includes(mode) ||
		!mode.startsWith(type)
	)
		return RespError(res, CommonStatus.PARAM_ERR);
	try {
		if (!(await canAccessRoom(req.user.id, room, type)))
			return RespError(res, CommonStatus.UNAUTHORIZED);
		if (!(await better_chat.get(`presence:${req.user.username}`)))
			return RespError(res, CommonStatus.CONNECTION_ERR);
		const recipients = (await getRecipients(req.user.id, room, type)).slice(
			0,
			MAX_PARTICIPANTS - 1
		);
		const candidates = await Promise.all(
			recipients.map(async item => ({
				item,
				online: !!(await better_chat.get(`presence:${item.username}`)),
				busy: !!(await better_chat.get(`rtc:busy:${item.username}`))
			}))
		);
		const online = candidates.filter(c => c.online && !c.busy).map(c => c.item);
		if (!online.length) return RespError(res, CommonStatus.NOT_FOUND);
		const state = await createCall(
			room,
			type,
			mode,
			req.user.username,
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
						.concat([{ username: req.user!.username, alias: req.user!.name || req.user!.username }])
				})
			)
		);
		RespData(res, { callId: state.id, recipients: online, expiresAt: state.expiresAt });
	} catch (error) {
		console.error('[rtc] invite failed:', error);
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

export const acceptCall = async (req: Request, res: Response): Promise<void> => {
	try {
		const state = await transitionCall(
			String(req.body?.callId || ''),
			req.user!.username,
			'accept'
		);
		if (!state || state.status === 'ended') return RespError(res, CommonStatus.NOT_FOUND);
		if (!(await canAccessRoom(req.user!.id, state.room, state.type))) {
			await transitionCall(state.id, req.user!.username, 'leave');
			return RespError(res, CommonStatus.UNAUTHORIZED);
		}
		RespData(res, { callId: state.id, status: state.status });
	} catch (err) {
		console.error('[rtc] accept:', err);
		RespError(res, CommonStatus.UNAUTHORIZED);
	}
};

export const endCall = async (req: Request, res: Response): Promise<void> => {
	try {
		const state = await transitionCall(String(req.body?.callId || ''), req.user!.username, 'leave');
		RespData(res, { ended: true, status: state?.status || 'ended' });
	} catch (err) {
		console.error('[rtc] end:', err);
		RespError(res, CommonStatus.UNAUTHORIZED);
	}
};
