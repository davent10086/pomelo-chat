import type { WebSocket } from 'ws';
import { forEachConcurrent } from '../../shared/parallel';

type SessionCheck = (token: string) => Promise<unknown>;
const sockets = new Map<WebSocket, { username: string; token: string; verify: SessionCheck; roomCheck?: () => Promise<boolean> }>();
let timer: ReturnType<typeof setInterval> | undefined;
let checking: Promise<void> | undefined;

/** Revalidate before every delivery/write; pubsub closes idle sockets promptly. */
export const registerSessionSocket = (
	ws: WebSocket,
	username: string,
	token: string,
	verify: SessionCheck,
	roomCheck?: () => Promise<boolean>
): void => {
	if (ws.readyState !== 1) return;
	sockets.set(ws, { username, token, verify, roomCheck });
	ws.once('close', () => sockets.delete(ws));
};

export const validateSessionSocket = async (ws: WebSocket, checkRoom = true): Promise<boolean> => {
	if (ws.readyState !== 1) return false;
	const session = sockets.get(ws);
	if (!session || !(await session.verify(session.token))) {
		if (ws.readyState < 2) ws.close(4001, 'session revoked');
		return false;
	}
	if (checkRoom && session.roomCheck && !(await session.roomCheck())) {
		if (ws.readyState < 2) ws.close(4003, 'room access revoked');
		return false;
	}
	return ws.readyState === 1;
};

export const closeRevokedSockets = (username: string, currentToken?: string): void => {
	for (const [ws, session] of sockets) {
		if (session.username === username && session.token !== currentToken)
			ws.close(4001, 'session revoked');
	}
};

export const startSessionChecks = () => {
	if (timer) return;
	timer = setInterval(() => {
		if (checking) return;
		checking = forEachConcurrent([...sockets.keys()], 16, async ws => {
			await validateSessionSocket(ws).catch(() => {
				if (ws.readyState < 2) ws.close(4001, 'session unavailable');
			});
		}).finally(() => { checking = undefined; });
	}, 15000);
	timer.unref();
};
export const stopSessionChecks = async () => {
	if (timer) clearInterval(timer);
	timer = undefined;
	await Promise.all(
		[...sockets.keys()].map(
			ws =>
				new Promise<void>(resolve => {
					if (ws.readyState === 3) {
						resolve();
						return;
					}
					const timeout = setTimeout(() => {
						ws.terminate();
						resolve();
					}, 1000);
					ws.once('close', () => {
						clearTimeout(timeout);
						resolve();
					});
					if (ws.readyState < 2) ws.close(1001, 'server stopping');
				})
		)
	);
	sockets.clear();
};
