import type { WebSocket } from 'ws';
import type { JwtPayload } from 'jsonwebtoken';

/**
 * 全局登录用户房间
 * key: username, value: 该用户的连接与通话状态
 */
export interface LoginRoomEntry {
	ws: WebSocket;
	status: boolean;
}

declare global {
	// eslint-disable-next-line no-var
	var LoginRooms: Record<string, LoginRoomEntry>;
}

export {};
