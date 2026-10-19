import type { WebSocket } from 'ws';
import { validateSessionSocket } from './session-sockets';
import { better_chat } from '../../infrastructure/redis';
import type { ChatType, UserId } from '../messaging/contracts';
import { forEachConcurrent } from '../../shared/parallel';

const rooms = new Map<WebSocket, { userId: UserId; room: string; type: ChatType }>();
export const registerRoomSocket = (ws: WebSocket, userId: UserId, room: string, type: ChatType) => {
	rooms.set(ws, { userId, room, type });
	ws.once('close', () => rooms.delete(ws));
};
export const validateRoomSocket = async (ws: WebSocket): Promise<boolean> => {
	if (!(await validateSessionSocket(ws))) return false;
	const scope = rooms.get(ws);
	if (!scope) return false;
	return ws.readyState === 1;
};
export const recheckRoomSockets = async (room: string, userId?: UserId) => {
	await forEachConcurrent(
		[...rooms].filter(
			([, scope]) =>
				scope.room === room && (userId === undefined || String(scope.userId) === String(userId))
		),
		16,
		async ([ws]) => {
			try {
				await validateRoomSocket(ws);
			} catch {
				ws.close(4003, 'room access unavailable');
			}
		}
	);
};
export const notifyRoomAccessChanged = async (room: string, type: ChatType, userId: UserId) => {
	await recheckRoomSockets(room, userId);
	await better_chat.publish(
		`${process.env.REDIS_KEY_PREFIX || ''}pomelo:room:access`,
		JSON.stringify({ room, type, userId: String(userId) })
	);
};
