import { z } from 'zod';

export const MEMORY_QUERY_MAX_LENGTH = 120;
export const isSensitiveMemoryContent = (content: string): boolean =>
	/(api[_ -]?key|token|password|secret|密钥|密码|口令)/i.test(content);

export const memorySaveSchema = z.object({
	content: z
		.string()
		.trim()
		.min(1)
		.max(1000)
		.refine(
			content => !isSensitiveMemoryContent(content),
			'Secrets and credentials are not stored in memory.'
		)
		.describe('A concise fact or preference the user explicitly asked the assistant to remember.'),
	category: z
		.string()
		.trim()
		.max(32)
		.optional()
		.describe('Memory category, such as preference, profile, project, or instruction.')
});
export const memoryForgetSchema = z.object({
	id: z.number().int().positive().describe('Exact memory id to delete.')
});
