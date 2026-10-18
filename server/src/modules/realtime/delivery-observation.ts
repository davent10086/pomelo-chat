import { randomBytes } from 'crypto';
import type { WebSocket } from 'ws';
import {
	countMessageMetric,
	observeMessageMetric,
	setMessageGauge
} from '../../infrastructure/message-metrics';

interface Receipt {
	ws: WebSocket;
	sentAt: number;
	expiresAt: number;
	persistedAt?: number;
}
const pending = new Map<string, Receipt>();
const sockets = new WeakMap<WebSocket, Set<string>>();
const MAX_PENDING = 20000,
	MAX_PER_SOCKET = 128,
	TTL_MS = 30000;
let timer: ReturnType<typeof setInterval> | undefined;
const remove = (token: string) => {
	const receipt = pending.get(token);
	if (receipt) sockets.get(receipt.ws)?.delete(token);
	pending.delete(token);
	setMessageGauge('pomelo_delivery_receipts_pending', pending.size);
};
const expire = () => {
	for (const [token, receipt] of pending) {
		if (receipt.expiresAt > performance.now()) break;
		remove(token);
		countMessageMetric('pomelo_delivery_receipts_expired_total');
	}
};
export const startDeliveryObservation = (): void => {
	if (!timer) {
		timer = setInterval(expire, 5000);
		timer.unref();
	}
};
export const stopDeliveryObservation = (): void => {
	if (timer) clearInterval(timer);
	timer = undefined;
	for (const token of pending.keys()) remove(token);
};
export const trackDelivery = (ws: WebSocket, persistedAt?: number): string | undefined => {
	if (ws.readyState !== 1) return;
	let tokens = sockets.get(ws);
	if (!tokens) {
		tokens = new Set();
		sockets.set(ws, tokens);
		ws.once('close', () => {
			for (const token of sockets.get(ws) || []) {
				remove(token);
				countMessageMetric('pomelo_delivery_receipts_closed_total');
			}
		});
	}
	for (const token of tokens) {
		if (pending.get(token)!.expiresAt > performance.now()) break;
		remove(token);
		countMessageMetric('pomelo_delivery_receipts_expired_total');
	}
	if (tokens.size >= MAX_PER_SOCKET || pending.size >= MAX_PENDING) {
		countMessageMetric('pomelo_delivery_receipts_untracked_total');
		return;
	}
	const token = randomBytes(16).toString('hex');
	pending.set(token, {
		ws,
		persistedAt,
		sentAt: performance.now(),
		expiresAt: performance.now() + TTL_MS
	});
	tokens.add(token);
	countMessageMetric('pomelo_delivery_receipts_requested_total');
	setMessageGauge('pomelo_delivery_receipts_pending', pending.size);
	return token;
};
/** Only the exact connection given a random challenge can report it, once. */
export const acknowledgeDelivery = (ws: WebSocket, token: string): void => {
	const receipt = pending.get(token);
	if (!receipt || receipt.ws !== ws) return;
	remove(token);
	if (performance.now() > receipt.expiresAt) {
		countMessageMetric('pomelo_delivery_receipts_expired_total');
		return;
	}
	observeMessageMetric(
		'pomelo_message_socket_receive_seconds',
		(performance.now() - receipt.sentAt) / 1000
	);
	if (receipt.persistedAt !== undefined)
		observeMessageMetric(
			'pomelo_message_created_to_receive_seconds',
			Math.max(0, Date.now() - receipt.persistedAt) / 1000
		);
};
