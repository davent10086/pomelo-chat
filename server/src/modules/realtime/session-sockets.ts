import type { WebSocket } from 'ws';
import { verifyTokenWithSession, verifyTokensWithSessions } from '../identity/public';

type SessionCheck = (token: string) => Promise<unknown>;
const sockets = new Map<WebSocket, { username: string; token: string; verify: SessionCheck }>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Revalidate before every delivery/write; pubsub closes idle sockets promptly. */
export const registerSessionSocket = (
	ws: WebSocket,
	username: string,
	token: string,
	verify: SessionCheck
): void => {
	if (ws.readyState !== 1) return;
	sockets.set(ws, { username, token, verify });
	ws.on('pong', () => alive.set(ws, true));
	ws.once('close', () => sockets.delete(ws));
};
const alive = new WeakMap<WebSocket, boolean>();
export const validateSessionSockets = async (batch: WebSocket[]): Promise<Set<WebSocket>> => {
	const allowed = new Set<WebSocket>();
	const standard = batch.filter(ws => sockets.get(ws)?.verify === verifyTokenWithSession);
	const results = await verifyTokensWithSessions(standard.map(ws => sockets.get(ws)!.token));
	standard.forEach((ws, index) => {
		if (results[index] && ws.readyState === 1) allowed.add(ws);
		else if (ws.readyState < 2) ws.close(4001, 'session revoked');
	});
	await Promise.all(batch.filter(ws => !standard.includes(ws)).map(async ws => { if (await validateSessionSocket(ws)) allowed.add(ws); }));
	return allowed;
};

export const validateSessionSocket = async (ws: WebSocket): Promise<boolean> => {
	const session = sockets.get(ws);
	if (!session || !(await session.verify(session.token))) {
		if (ws.readyState < 2) ws.close(4001, 'session revoked');
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
		for (const ws of sockets.keys()) {
			if (alive.get(ws) === false) { ws.terminate(); continue; }
			if (typeof ws.ping === 'function') { alive.set(ws, false); ws.ping(); }
			void validateSessionSocket(ws).catch(() => {
				if (ws.readyState < 2) ws.close(4001, 'session unavailable');
			});
		}
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
