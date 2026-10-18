/** Rejection before persistence; never discard committed messages. */
export class MessageOverloadError extends Error {
	readonly code = 'MESSAGE_OVERLOADED';
	constructor(
		readonly reason: string,
		readonly retryAfterMs = 1000
	) {
		super('消息发送繁忙，请稍后重试');
	}
}
export const positiveSetting = (name: string, fallback: number): number => {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};
