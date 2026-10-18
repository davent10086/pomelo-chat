import type { WebSocket } from 'ws';

interface Connection {
	ws: WebSocket;
	dispose: () => Promise<void>;
}
const connections = new Map<string, Connection>();
const cleanups = new Set<Promise<void>>();

export const getNotificationSocket = (username: string) => connections.get(username)?.ws;
export const notificationUsers = () => [...connections.keys()];
export const registerNotificationSocket = (
	username: string,
	ws: WebSocket,
	cleanup: () => Promise<void>
) => {
	const previous = connections.get(username);
	let disposed: Promise<void> | undefined;
	connections.set(username, {
		ws,
		dispose: () => {
			if (!disposed) {
				disposed = cleanup().catch(error =>
					console.error('[notification] connection cleanup:', error)
				);
				cleanups.add(disposed);
				void disposed.then(() => cleanups.delete(disposed!));
			}
			return disposed;
		}
	});
	if (previous && previous.ws !== ws) {
		void previous.dispose();
		previous.ws.close(4004, 'connection replaced');
	}
};
export const removeNotificationSocket = (username: string, ws: WebSocket): boolean => {
	const current = connections.get(username);
	if (!current || current.ws !== ws) return false;
	connections.delete(username);
	void current.dispose();
	return true;
};
export const stopNotificationConnections = async () => {
	const current = [...connections.values()];
	connections.clear();
	for (const { ws } of current) if (ws.readyState < 2) ws.close(1001, 'server stopping');
	await Promise.all(current.map(connection => connection.dispose()));
	await Promise.all([...cleanups]);
};
