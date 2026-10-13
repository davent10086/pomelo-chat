const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
export const requestChatCompletion = (
	messages: unknown,
	stream: boolean,
	signal: AbortSignal
): Promise<Response> =>
	fetch(`${API_BASE}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
		body: JSON.stringify({ model: MODEL, messages, stream }),
		signal
	});
