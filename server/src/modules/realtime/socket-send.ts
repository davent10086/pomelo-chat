import type { WebSocket } from 'ws';

const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Slow clients reconnect and recover from persisted history instead of growing buffers. */
export const sendSocketFrame = (ws: WebSocket, frame: unknown): void => {
	if (ws.readyState !== 1) return;
	const payload = JSON.stringify(frame);
	if (ws.bufferedAmount + Buffer.byteLength(payload) > MAX_BUFFERED_BYTES) {
		ws.terminate();
		return;
	}
	ws.send(payload, error => {
		if (error) {
			console.error('[socket] send failed:', error.message);
			ws.terminate();
		}
	});
};
