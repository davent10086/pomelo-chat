import { tool } from 'langchain';
import { z } from 'zod';

import { Query } from '../../../utils/query';

export interface PomeloToolContext {
	userId: number;
	currentRoom?: string;
}

export interface PomeloToolDefinition {
	name: string;
	description: string;
	kind: 'read' | 'suggestion' | 'write';
	inputSchema: Record<string, unknown>;
}

export interface PomeloToolCall {
	name: string;
	args?: Record<string, unknown>;
	room?: string;
}

interface PomeloToolSpec extends PomeloToolDefinition {
	schema: z.ZodTypeAny;
	run: (context: PomeloToolContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const recentMessagesSchema = z.object({
	room: z.string().optional().describe('Chat room id. Defaults to the current room.'),
	limit: z.number().optional().describe('Message count. Defaults to 30, maximum 80.')
});

const searchSchema = z.object({
	query: z.string().describe('Search keyword.')
});

const extractTodosSchema = z.object({
	text: z.string().describe('Text to inspect for todo items.')
});

const suggestRepliesSchema = z.object({
	text: z.string().describe('Recent conversation context.'),
	count: z.number().optional().describe('Suggestion count. Defaults to 3, maximum 5.')
});

const memorySearchSchema = z.object({
	query: z.string().optional().describe('Keyword to search in the current user memory.'),
	limit: z.number().optional().describe('Maximum memories to return. Defaults to 8.')
});

const memorySaveSchema = z.object({
	content: z.string().min(1).max(1000).describe('A concise fact or preference the user explicitly asked the assistant to remember.'),
	category: z.string().max(32).optional().describe('Memory category, such as preference, profile, project, or instruction.')
});

const memoryForgetSchema = z.object({
	query: z.string().min(1).describe('Exact or distinctive text identifying memories to delete.')
});

const canAccessRoom = async (userId: number, room: string): Promise<boolean> => {
	const sql = `
		SELECT 1 AS ok
		FROM friend AS f
		INNER JOIN friend_group AS fg ON fg.id = f.group_id
		WHERE fg.user_id = ? AND f.room = ?
		LIMIT 1
	`;
	const privateRows: any = await Query(sql, [userId, room]);
	if (privateRows.length > 0) return true;

	const groupSql = `
		SELECT 1 AS ok
		FROM group_chat AS gc
		INNER JOIN group_members AS gm ON gm.group_id = gc.id
		WHERE gm.user_id = ? AND gc.room = ?
		LIMIT 1
	`;
	const groupRows: any = await Query(groupSql, [userId, room]);
	return groupRows.length > 0;
};

const getRecentMessagesForRoom = async (
	userId: number,
	room: string,
	limit = 30
): Promise<any[]> => {
	if (!room || !(await canAccessRoom(userId, room))) {
		return [];
	}
	const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 80));
	const sql = `
		SELECT
			m.sender_id,
			m.receiver_id,
			m.content,
			m.media_type,
			m.created_at,
			u.username AS sender_username,
			u.name AS sender_name
		FROM message AS m
		LEFT JOIN user AS u ON u.id = m.sender_id
		WHERE m.room = ?
		ORDER BY m.created_at DESC
		LIMIT ?
	`;
	const rows: any[] = await Query(sql, [room, safeLimit]);
	return rows.reverse();
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const pomeloToolSpecs: PomeloToolSpec[] = [
	{
		name: 'get_recent_messages',
		description: 'Read recent messages from a room visible to the current user. This tool never modifies messages.',
		kind: 'read',
		inputSchema: {
			type: 'object',
			properties: {
				room: { type: 'string', description: 'Chat room id. Defaults to the current room.' },
				limit: { type: 'number', description: 'Message count. Defaults to 30, maximum 80.' }
			}
		},
		schema: recentMessagesSchema,
		run: async (context, args) => {
			const messages = await getRecentMessagesForRoom(
				context.userId,
				asText(args.room) || context.currentRoom || '',
				Number(args.limit) || 30
			);
			return {
				messages: messages.map(item => ({
					sender: item.sender_name || item.sender_username || item.sender_id,
					content: item.content,
					type: item.media_type,
					created_at: item.created_at
				}))
			};
		}
	},
	{
		name: 'search_contacts',
		description: 'Search contacts visible to the current user by username, display name, or remark.',
		kind: 'read',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'Contact search keyword.' }
			}
		},
		schema: searchSchema,
		run: async (context, args) => {
			const keyword = `%${asText(args.query)}%`;
			const sql = `
				SELECT
					f.user_id AS user_id,
					f.username,
					f.remark,
					f.room,
					u.name,
					u.signature
				FROM friend AS f
				INNER JOIN friend_group AS fg ON fg.id = f.group_id
				LEFT JOIN user AS u ON u.id = f.user_id
				WHERE fg.user_id = ? AND (f.username LIKE ? OR f.remark LIKE ? OR u.name LIKE ?)
				LIMIT 10
			`;
			const rows: any = await Query(sql, [context.userId, keyword, keyword, keyword]);
			return { contacts: rows };
		}
	},
	{
		name: 'search_groups',
		description: 'Search groups joined by the current user.',
		kind: 'read',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'Group name search keyword.' }
			}
		},
		schema: searchSchema,
		run: async (context, args) => {
			const keyword = `%${asText(args.query)}%`;
			const sql = `
				SELECT gc.id, gc.name, gc.room, gc.announcement
				FROM group_chat AS gc
				INNER JOIN group_members AS gm ON gm.group_id = gc.id
				WHERE gm.user_id = ? AND gc.name LIKE ?
				LIMIT 10
			`;
			const rows: any = await Query(sql, [context.userId, keyword]);
			return { groups: rows };
		}
	},
	{
		name: 'extract_todos',
		description: 'Extract todo suggestions from text. This tool only suggests and never writes data.',
		kind: 'suggestion',
		inputSchema: {
			type: 'object',
			required: ['text'],
			properties: {
				text: { type: 'string', description: 'Text to inspect for todo items.' }
			}
		},
		schema: extractTodosSchema,
		run: async (_context, args) => {
			const lines = asText(args.text)
				.split(/\n+/)
				.map(item => item.trim())
				.filter(item => /(\u5f85\u529e|\u63d0\u9192|\u8bb0\u5f97|\u9700\u8981|\u660e\u5929|\u4eca\u5929|\u4e0b\u5468|\u5468[一二三四五六日天]|todo)/i.test(item))
				.slice(0, 8);
			return { todos: lines.map(title => ({ title })) };
		}
	},
	{
		name: 'suggest_replies',
		description: 'Generate short reply suggestions. This tool never sends messages.',
		kind: 'suggestion',
		inputSchema: {
			type: 'object',
			required: ['text'],
			properties: {
				text: { type: 'string', description: 'Recent conversation context.' },
				count: { type: 'number', description: 'Suggestion count. Defaults to 3, maximum 5.' }
			}
		},
		schema: suggestRepliesSchema,
		run: async (_context, args) => {
			const safeCount = Math.max(1, Math.min(Number(args.count) || 3, 5));
			const base = asText(args.text).trim();
			const lower = base.toLowerCase();
			const suggestions = lower.includes('?') || lower.includes('\uff1f')
				? ['\u6211\u5148\u6838\u5bf9\u8fd9\u4e2a\u95ee\u9898\uff0c\u7a0d\u540e\u7ed9\u4f60\u660e\u786e\u7b54\u590d\u3002', '\u53ef\u4ee5\uff0c\u6211\u4f1a\u6839\u636e\u8fd9\u4e2a\u65b9\u5411\u5904\u7406\u3002', '\u6211\u9700\u8981\u5148\u786e\u8ba4\u4e00\u4e2a\u7ec6\u8282\uff0c\u7136\u540e\u56de\u590d\u4f60\u3002']
				: lower.includes('\u8c22\u8c22') || lower.includes('thanks')
					? ['\u4e0d\u5ba2\u6c14\uff0c\u6709\u9700\u8981\u968f\u65f6\u544a\u8bc9\u6211\u3002', '\u6536\u5230\uff0c\u6211\u4f1a\u7ee7\u7eed\u8ddf\u8fdb\u3002', '\u597d\u7684\uff0c\u6211\u4eec\u4fdd\u6301\u540c\u6b65\u3002']
					: /(bug|error|issue|\u95ee\u9898|\u5f02\u5e38|\u6545\u969c)/i.test(lower)
						? ['\u6536\u5230\uff0c\u6211\u5148\u6392\u67e5\u8fd9\u4e2a\u95ee\u9898\u3002', '\u6211\u4f1a\u8ddf\u8fdb\u5904\u7406\uff0c\u6709\u7ed3\u679c\u53ca\u65f6\u540c\u6b65\u3002', '\u8bf7\u518d\u63d0\u4f9b\u4e00\u4e2a\u590d\u73b0\u6b65\u9aa4\uff0c\u65b9\u4fbf\u6211\u5b9a\u4f4d\u3002']
						: ['\u6211\u7406\u89e3\u4e86\uff0c\u6211\u6765\u8ddf\u8fdb\u8fd9\u4ef6\u4e8b\u3002', '\u53ef\u4ee5\uff0c\u6211\u7a0d\u540e\u628a\u7ed3\u679c\u540c\u6b65\u7ed9\u4f60\u3002', '\u8fd9\u4e2a\u601d\u8def\u4e0d\u9519\uff0c\u6211\u4eec\u53ef\u4ee5\u5148\u4ece\u6700\u5173\u952e\u7684\u4e00\u6b65\u5f00\u59cb\u3002', '\u6211\u9700\u8981\u518d\u786e\u8ba4\u4e00\u4e2a\u7ec6\u8282\uff0c\u7136\u540e\u5c31\u80fd\u7ee7\u7eed\u63a8\u8fdb\u3002', '\u6536\u5230\uff0c\u6211\u4f1a\u6309\u8fd9\u4e2a\u65b9\u5411\u5904\u7406\u3002'];
			return {
				source: base.slice(0, 200),
				suggestions: suggestions.slice(0, safeCount)
			};
		}
	},
	{
		name: 'search_memory',
		description: 'Read the current user\'s saved preferences and facts. This is private to the current user and never reads other users\' memories.',
		kind: 'read',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Optional keyword.' },
				limit: { type: 'number', description: 'Maximum result count. Defaults to 8.' }
			}
		},
		schema: memorySearchSchema,
		run: async (context, args) => {
			const query = asText(args.query).trim();
			const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20));
			const like = `%${query}%`;
			const sql = `
				SELECT id, category, content, created_at, updated_at
				FROM assistant_memory
				WHERE user_id = ? AND (? = '' OR content LIKE ? OR category LIKE ?)
				ORDER BY updated_at DESC
				LIMIT ?
			`;
			const rows: any[] = await Query(sql, [context.userId, query, like, like, limit]);
			return { memories: rows };
		}
	},
	{
		name: 'save_memory',
		description: 'Save a concise private memory only when the user explicitly asks to remember, save, or keep a fact or preference. Never save secrets, passwords, API keys, or entire chat transcripts.',
		kind: 'write',
		inputSchema: {
			type: 'object',
			required: ['content'],
			properties: {
				content: { type: 'string', description: 'Concise fact or preference to remember.' },
				category: { type: 'string', description: 'preference, profile, project, or instruction.' }
			}
		},
		schema: memorySaveSchema,
		run: async (context, args) => {
			const content = asText(args.content).trim();
			if (/(api[_ -]?key|token|password|secret|密钥|密码|口令)/i.test(content)) {
				return { saved: false, reason: 'Secrets and credentials are not stored in memory.' };
			}
			const category = (asText(args.category).trim() || 'preference').slice(0, 32);
			await Query('INSERT INTO assistant_memory (user_id, category, content) VALUES (?, ?, ?)', [context.userId, category, content]);
			return { saved: true, category, content };
		}
	},
	{
		name: 'forget_memory',
		description: 'Delete the current user\'s saved memories matching the requested text. Use only when the user explicitly asks to forget or delete a memory.',
		kind: 'write',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: { query: { type: 'string', description: 'Text identifying memories to delete.' } }
		},
		schema: memoryForgetSchema,
		run: async (context, args) => {
			const query = asText(args.query).trim();
			const result: any = await Query('DELETE FROM assistant_memory WHERE user_id = ? AND content LIKE ?', [context.userId, `%${query}%`]);
			return { deleted: result.affectedRows || 0 };
		}
	}
];

export const pomeloToolDefinitions: PomeloToolDefinition[] = pomeloToolSpecs.map(
	({ name, description, kind, inputSchema }) => ({ name, description, kind, inputSchema })
);

export const executePomeloTool = async (
	context: PomeloToolContext,
	call: PomeloToolCall
): Promise<Record<string, unknown>> => {
	const spec = pomeloToolSpecs.find(item => item.name === call.name);
	if (!spec) {
		throw new Error(`Unknown tool: ${call.name}`);
	}
	const args = spec.schema.parse({
		...(call.args || {}),
		...(call.room ? { room: call.room } : {})
	}) as Record<string, unknown>;
	return spec.run(context, args);
};

export const buildPomeloChatTools = (
	context: PomeloToolContext,
	options: { exclude?: string[] } = {}
) =>
	pomeloToolSpecs
		.filter(spec => !options.exclude?.includes(spec.name))
		.map(spec =>
		tool(
			async args => {
				const result = await executePomeloTool(context, {
					name: spec.name,
					args: args as Record<string, unknown>
				});
				return JSON.stringify(result);
			},
			{
				name: spec.name,
				description: spec.description,
				schema: spec.schema
			}
		)
		);
