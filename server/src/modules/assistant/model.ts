import { ChatOpenAI } from '@langchain/openai';
import { boundedInteger } from '../../shared/validation';

export const API_BASE = (
	process.env.AI_BASE_URL ||
	process.env.DEEPSEEK_BASE_URL ||
	'https://dashscope.aliyuncs.com/compatible-mode/v1'
).replace(/\/v1\/?$/, '');
export const API_KEY =
	process.env.AI_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.DEEPSEEK_API_KEY || '';
export const MODEL = process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || 'qwen-plus';
export const UPSTREAM_TIMEOUT_MS = 30000;

export const createAssistantModel = (options: { temperature: number; maxRetries?: number }) =>
	new ChatOpenAI({
		model: MODEL,
		apiKey: API_KEY,
		timeout: UPSTREAM_TIMEOUT_MS,
		streamUsage: false,
		maxTokens: boundedInteger('AI_MAX_OUTPUT_TOKENS', 4096, 128, 32768),
		configuration: { baseURL: `${API_BASE}/v1` },
		...options
	});
