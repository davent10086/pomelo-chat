import { ChatOpenAI } from '@langchain/openai';

export const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(
	/\/v1\/?$/,
	''
);
export const API_KEY = process.env.DEEPSEEK_API_KEY || '';
export const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
export const UPSTREAM_TIMEOUT_MS = 30000;

export const createAssistantModel = (options: { temperature: number; maxRetries?: number }) =>
	new ChatOpenAI({
		model: MODEL,
		apiKey: API_KEY,
		timeout: UPSTREAM_TIMEOUT_MS,
		streamUsage: false,
		configuration: { baseURL: `${API_BASE}/v1` },
		...options
	});
