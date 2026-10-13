import * as repository from '../repository';
import { accessibleRoomType, searchVisibleContacts, searchJoinedGroups } from '../../social/public';
import { searchRoomMessages, messageContextById, recentRoomMessages } from '../../messaging/public';
import { tool } from 'langchain';
import { z } from 'zod';

export interface PomeloToolContext {
	userId: number;
	currentRoom?: string;
	confirmationId?: string;
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
	run: (
		context: PomeloToolContext,
		args: Record<string, unknown>
	) => Promise<Record<string, unknown>>;
}

interface RecentMessageRow {
	id: number;
	room?: string;
	sender_id: number | string;
	receiver_id: number | string;
	content: string;
	media_type: 'text' | 'image' | 'video' | 'file';
	created_at: Date | string;
	sender_username: string | null;
	sender_name: string | null;
}

interface AssistantMemoryRow {
	id: number;
	category: string;
	content: string;
	created_at: Date | string;
	updated_at: Date | string;
}

interface AssistantTaskRow {
	id: number;
	title: string;
	assignee: string | null;
	due: string | null;
	status: 'open' | 'completed';
	sourceRoom: string | null;
}

interface WriteResult {
	affectedRows: number;
}

const recentMessagesSchema = z.object({
	room: z.string().optional().describe('Chat room id. Defaults to the current room.'),
	limit: z.number().optional().describe('Message count. Defaults to 30, maximum 80.')
});

const searchMessagesSchema = z.object({
	room: z.string().min(1).max(255).optional().describe('Room id; defaults to the current room.'),
	query: z.string().trim().min(1).max(120).describe('Literal keyword to find in text messages.'),
	since: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe('First date to include, YYYY-MM-DD.'),
	until: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe('Last date to include, YYYY-MM-DD.'),
	beforeId: z.number().int().positive().optional().describe('Cursor from a previous result.'),
	limit: z.number().int().min(1).max(20).optional().describe('At most 20 matches; defaults to 10.')
});

const messageContextSchema = z.object({
	messageId: z.number().int().positive().describe('Id of the message to inspect.'),
	before: z.number().int().min(0).max(5).optional().describe('Messages before, up to 5.'),
	after: z.number().int().min(0).max(5).optional().describe('Messages after, up to 5.')
});

const listTasksSchema = z.object({
	status: z.enum(['open', 'completed', 'all']).optional().describe('Defaults to open.'),
	sourceRoom: z.string().min(1).max(255).optional().describe('Optional source room filter.'),
	beforeId: z.number().int().positive().optional().describe('Cursor from a previous result.'),
	limit: z.number().int().min(1).max(20).optional().describe('At most 20 tasks; defaults to 10.')
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
	content: z
		.string()
		.min(1)
		.max(1000)
		.describe('A concise fact or preference the user explicitly asked the assistant to remember.'),
	category: z
		.string()
		.max(32)
		.optional()
		.describe('Memory category, such as preference, profile, project, or instruction.')
});

const memoryForgetSchema = z.object({
	id: z.number().int().positive().describe('Exact memory id to delete.')
});

export const canAccessRoom = async (userId: number, room: string): Promise<boolean> =>
	Boolean(await accessibleRoomType(userId, room));

export const getRecentMessagesForRoom = async (
	userId: number,
	room: string,
	limit = 30
): Promise<RecentMessageRow[]> => {
	const type = await accessibleRoomType(userId, room);
	if (!type) return [];
	return recentRoomMessages(userId, room, type, limit);
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const presentMessage = (item: RecentMessageRow) => ({
	id: item.id,
	sender: item.sender_name || item.sender_username || item.sender_id,
	content: item.media_type === 'text' ? item.content.slice(0, 500) : '',
	type: item.media_type,
	created_at: item.created_at
});
export const isSensitiveMemoryContent = (content: string): boolean =>
	/(api[_ -]?key|token|password|secret|密钥|密码|口令)/i.test(content);

const pomeloToolSpecs: PomeloToolSpec[] = [
	{
		name: 'get_recent_messages',
		description:
			'Read recent messages from a room visible to the current user. This tool never modifies messages.',
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
					id: item.id,
					sender: item.sender_name || item.sender_username || item.sender_id,
					content: item.content,
					type: item.media_type,
					created_at: item.created_at
				}))
			};
		}
	},
	{
		name: 'search_messages',
		description:
			'Search text messages in one room visible to the current user. Returns message ids and short excerpts for follow-up context lookup.',
		kind: 'read',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: {
				room: { type: 'string' },
				query: { type: 'string' },
				since: { type: 'string', description: 'YYYY-MM-DD' },
				until: { type: 'string', description: 'YYYY-MM-DD' },
				beforeId: { type: 'integer' },
				limit: { type: 'integer', maximum: 20 }
			}
		},
		schema: searchMessagesSchema,
		run: async (context, args) => {
			const room = asText(args.room) || context.currentRoom || '';
			const type = await accessibleRoomType(context.userId, room);
			if (!type) return { matches: [], hasMore: false };
			const result = await searchRoomMessages(context.userId, room, type, {
				query: asText(args.query),
				since: args.since as string | undefined,
				until: args.until as string | undefined,
				beforeId: args.beforeId as number | undefined,
				limit: Number(args.limit) || 10
			});
			if (!result) return { matches: [], hasMore: false };
			return {
				matches: result.messages.map(item => ({
					...presentMessage(item),
					content: item.content.slice(0, 240)
				})),
				hasMore: result.hasMore,
				nextBeforeId: result.hasMore ? result.nextBeforeId : undefined
			};
		}
	},
	{
		name: 'get_message_context',
		description:
			'Read a message and nearby messages after checking access to its room. Use a message id from search_messages.',
		kind: 'read',
		inputSchema: {
			type: 'object',
			required: ['messageId'],
			properties: {
				messageId: { type: 'integer' },
				before: { type: 'integer', maximum: 5 },
				after: { type: 'integer', maximum: 5 }
			}
		},
		schema: messageContextSchema,
		run: async (context, args) => {
			const messageId = Number(args.messageId);
			const result = await messageContextById(
				context.userId,
				messageId,
				Number(args.before ?? 3),
				Number(args.after ?? 3)
			);
			return result
				? {
						found: true,
						room: result.room,
						focusId: messageId,
						messages: result.messages.map(presentMessage)
					}
				: { found: false, messages: [] };
		}
	},
	{
		name: 'list_my_tasks',
		description: "List the current user's saved personal tasks. Never creates or changes tasks.",
		kind: 'read',
		inputSchema: {
			type: 'object',
			properties: {
				status: { type: 'string', enum: ['open', 'completed', 'all'] },
				sourceRoom: { type: 'string' },
				beforeId: { type: 'integer' },
				limit: { type: 'integer', maximum: 20 }
			}
		},
		schema: listTasksSchema,
		run: async (context, args) => {
			const limit = Number(args.limit) || 10;
			const conditions = ['user_id = ?'];
			const values: unknown[] = [context.userId];
			if (args.status !== 'all') {
				conditions.push('status = ?');
				values.push(args.status || 'open');
			}
			if (args.sourceRoom) {
				conditions.push('source_room = ?');
				values.push(args.sourceRoom);
			}
			if (args.beforeId) {
				conditions.push('id < ?');
				values.push(args.beforeId);
			}
			const rows = await repository.listFilteredTasks<AssistantTaskRow[]>([...values, limit + 1], {
				conditions
			});
			const tasks = rows.slice(0, limit);
			return {
				tasks,
				hasMore: rows.length > limit,
				nextBeforeId: rows.length > limit ? tasks[tasks.length - 1]?.id : undefined
			};
		}
	},
	{
		name: 'search_contacts',
		description:
			'Search contacts visible to the current user by username, display name, or remark.',
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
			const rows = await searchVisibleContacts(context.userId, asText(args.query));
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
			const rows = await searchJoinedGroups(context.userId, asText(args.query));
			return { groups: rows };
		}
	},
	{
		name: 'extract_todos',
		description:
			'Extract todo suggestions from text. This tool only suggests and never writes data.',
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
				.filter(item =>
					/(\u5f85\u529e|\u63d0\u9192|\u8bb0\u5f97|\u9700\u8981|\u660e\u5929|\u4eca\u5929|\u4e0b\u5468|\u5468[一二三四五六日天]|todo)/i.test(
						item
					)
				)
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
			const suggestions =
				lower.includes('?') || lower.includes('\uff1f')
					? [
							'\u6211\u5148\u6838\u5bf9\u8fd9\u4e2a\u95ee\u9898\uff0c\u7a0d\u540e\u7ed9\u4f60\u660e\u786e\u7b54\u590d\u3002',
							'\u53ef\u4ee5\uff0c\u6211\u4f1a\u6839\u636e\u8fd9\u4e2a\u65b9\u5411\u5904\u7406\u3002',
							'\u6211\u9700\u8981\u5148\u786e\u8ba4\u4e00\u4e2a\u7ec6\u8282\uff0c\u7136\u540e\u56de\u590d\u4f60\u3002'
						]
					: lower.includes('\u8c22\u8c22') || lower.includes('thanks')
						? [
								'\u4e0d\u5ba2\u6c14\uff0c\u6709\u9700\u8981\u968f\u65f6\u544a\u8bc9\u6211\u3002',
								'\u6536\u5230\uff0c\u6211\u4f1a\u7ee7\u7eed\u8ddf\u8fdb\u3002',
								'\u597d\u7684\uff0c\u6211\u4eec\u4fdd\u6301\u540c\u6b65\u3002'
							]
						: /(bug|error|issue|\u95ee\u9898|\u5f02\u5e38|\u6545\u969c)/i.test(lower)
							? [
									'\u6536\u5230\uff0c\u6211\u5148\u6392\u67e5\u8fd9\u4e2a\u95ee\u9898\u3002',
									'\u6211\u4f1a\u8ddf\u8fdb\u5904\u7406\uff0c\u6709\u7ed3\u679c\u53ca\u65f6\u540c\u6b65\u3002',
									'\u8bf7\u518d\u63d0\u4f9b\u4e00\u4e2a\u590d\u73b0\u6b65\u9aa4\uff0c\u65b9\u4fbf\u6211\u5b9a\u4f4d\u3002'
								]
							: [
									'\u6211\u7406\u89e3\u4e86\uff0c\u6211\u6765\u8ddf\u8fdb\u8fd9\u4ef6\u4e8b\u3002',
									'\u53ef\u4ee5\uff0c\u6211\u7a0d\u540e\u628a\u7ed3\u679c\u540c\u6b65\u7ed9\u4f60\u3002',
									'\u8fd9\u4e2a\u601d\u8def\u4e0d\u9519\uff0c\u6211\u4eec\u53ef\u4ee5\u5148\u4ece\u6700\u5173\u952e\u7684\u4e00\u6b65\u5f00\u59cb\u3002',
									'\u6211\u9700\u8981\u518d\u786e\u8ba4\u4e00\u4e2a\u7ec6\u8282\uff0c\u7136\u540e\u5c31\u80fd\u7ee7\u7eed\u63a8\u8fdb\u3002',
									'\u6536\u5230\uff0c\u6211\u4f1a\u6309\u8fd9\u4e2a\u65b9\u5411\u5904\u7406\u3002'
								];
			return {
				source: base.slice(0, 200),
				suggestions: suggestions.slice(0, safeCount)
			};
		}
	},
	{
		name: 'search_memory',
		description:
			"Read the current user's saved preferences and facts. This is private to the current user and never reads other users' memories.",
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

			const rows = await repository.searchOwnedMemories<AssistantMemoryRow[]>([
				context.userId,
				query,
				like,
				like,
				limit
			]);
			return { memories: rows };
		}
	},
	{
		name: 'save_memory',
		description:
			'Save a concise private memory only when the user explicitly asks to remember, save, or keep a fact or preference. Never save secrets, passwords, API keys, or entire chat transcripts.',
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
			if (isSensitiveMemoryContent(content)) {
				return { saved: false, reason: 'Secrets and credentials are not stored in memory.' };
			}
			const category = (asText(args.category).trim() || 'preference').slice(0, 32);
			if (context.confirmationId) {
				await repository.saveMemoryIdempotently([
					context.userId,
					category,
					content,
					context.confirmationId
				]);
			} else {
				await repository.insertMemory([context.userId, category, content]);
			}
			return { saved: true, category, content };
		}
	},
	{
		name: 'forget_memory',
		description: 'Delete one saved memory by id after user confirmation.',
		kind: 'write',
		inputSchema: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'integer', description: 'Exact memory id.' } }
		},
		schema: memoryForgetSchema,
		run: async (context, args) => {
			const result = await repository.deleteOwnedMemory<WriteResult>([context.userId, args.id]);
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
	if (spec.kind === 'write' && !context.confirmationId) {
		throw new Error(`Tool ${call.name} requires a confirmed action`);
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
		.filter(spec => spec.kind !== 'write' && !options.exclude?.includes(spec.name))
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
