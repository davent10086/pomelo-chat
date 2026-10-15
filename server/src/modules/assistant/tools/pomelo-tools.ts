import * as repository from '../repository';
import { accessibleRoomType, searchVisibleContacts, searchJoinedGroups } from '../../social/public';
import { searchRoomMessages, messageContextById, recentRoomMessages } from '../../messaging/public';
import { tool } from 'langchain';
import { z } from 'zod';
import { memorySaveSchema, memoryForgetSchema, MEMORY_QUERY_MAX_LENGTH } from './memory-contracts';
import { assertToolRateLimit, ToolExecutionError, toolErrorResult } from './tool-runtime';

export interface PomeloToolContext {
	userId: number;
	currentRoom?: string;
	confirmationId?: string;
	/** Owned by one Agent invocation; never shared across requests. */
	memoryReads?: Map<string, Promise<Record<string, unknown>>>;
}

export interface PomeloToolDefinition {
	name: string;
	description: string;
	kind: 'read' | 'suggestion' | 'write';
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
}

export interface PomeloToolCall {
	name: string;
	args?: Record<string, unknown>;
	room?: string;
}

interface PomeloToolSpec extends Omit<PomeloToolDefinition, 'inputSchema' | 'outputSchema'> {
	output: z.ZodTypeAny;
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
	room: z
		.string()
		.min(1)
		.max(255)
		.optional()
		.describe('Chat room id. Defaults to the current room.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(80)
		.optional()
		.describe('Message count. Defaults to 30, maximum 80.')
});

const searchMessagesSchema = z.object({
	room: z.string().min(1).max(255).optional().describe('Room id; defaults to the current room.'),
	query: z.string().trim().min(1).max(120).describe('Literal keyword to find in text messages.'),
	since: z.iso.date().optional().describe('First date to include, YYYY-MM-DD.'),
	until: z.iso.date().optional().describe('Last date to include, YYYY-MM-DD.'),
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
	query: z.string().trim().min(1).max(120).describe('Search keyword.')
});

const extractTodosSchema = z.object({
	text: z.string().min(1).max(20000).describe('Text to inspect for todo items.')
});

const suggestRepliesSchema = z.object({
	text: z.string().min(1).max(20000).describe('Recent conversation context.'),
	count: z
		.number()
		.int()
		.min(1)
		.max(5)
		.optional()
		.describe('Suggestion count. Defaults to 3, maximum 5.')
});

const memorySearchSchema = z.object({
	query: z
		.string()
		.trim()
		.max(MEMORY_QUERY_MAX_LENGTH)
		.optional()
		.describe('Keyword to search in the current user memory.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe('Maximum memories to return. Defaults to 8.')
});

export const canAccessRoom = async (userId: number, room: string): Promise<boolean> =>
	Boolean(await accessibleRoomType(userId, room));

export const getRecentMessagesForRoom = async (
	userId: number,
	room: string,
	limit = 30
): Promise<RecentMessageRow[]> => {
	const type = await accessibleRoomType(userId, room);
	if (!type)
		throw new ToolExecutionError('TARGET_UNAVAILABLE', 'Room is unavailable or inaccessible.');
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
const messageOutput = z.object({
	id: z.number(),
	sender: z.union([z.string(), z.number()]),
	content: z.string(),
	type: z.string(),
	created_at: z.string()
});
const pageOutput = { hasMore: z.boolean(), nextBeforeId: z.number().optional() };
const toolOutputs = {
	get_recent_messages: z.object({ messages: z.array(messageOutput) }),
	search_messages: z.object({ matches: z.array(messageOutput), ...pageOutput }),
	get_message_context: z.object({
		found: z.literal(true),
		room: z.string(),
		focusId: z.number(),
		messages: z.array(messageOutput)
	}),
	list_my_tasks: z.object({
		tasks: z.array(
			z.object({
				id: z.number(),
				title: z.string(),
				status: z.enum(['open', 'completed']),
				assignee: z.string().nullable(),
				due: z.string().nullable(),
				sourceRoom: z.string().nullable()
			})
		),
		...pageOutput
	}),
	search_contacts: z.object({
		contacts: z.array(
			z.object({
				user_id: z.number(),
				username: z.string(),
				remark: z.string().nullable(),
				room: z.string(),
				name: z.string().nullable(),
				signature: z.string().nullable()
			})
		)
	}),
	search_groups: z.object({
		groups: z.array(
			z.object({
				id: z.number(),
				name: z.string(),
				room: z.string(),
				announcement: z.string().nullable()
			})
		)
	}),
	extract_todos: z.object({ todos: z.array(z.object({ title: z.string() })) }),
	suggest_replies: z.object({ source: z.string(), suggestions: z.array(z.string()) }),
	search_memory: z.object({
		memories: z.array(
			z.object({
				id: z.number(),
				category: z.string(),
				content: z.string(),
				created_at: z.string(),
				updated_at: z.string()
			})
		)
	}),
	save_memory: z.object({ saved: z.literal(true), category: z.string(), content: z.string() }),
	forget_memory: z.object({ deleted: z.number().int().positive() })
};

const pomeloToolSpecs: PomeloToolSpec[] = [
	{
		name: 'get_recent_messages',
		output: toolOutputs.get_recent_messages,
		description:
			'Read recent messages from a room visible to the current user. This tool never modifies messages.',
		kind: 'read',
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
		output: toolOutputs.search_messages,
		description:
			'Search text messages in one room visible to the current user. Returns message ids and short excerpts for follow-up context lookup.',
		kind: 'read',
		schema: searchMessagesSchema,
		run: async (context, args) => {
			const room = asText(args.room) || context.currentRoom || '';
			const type = await accessibleRoomType(context.userId, room);
			if (!type)
				throw new ToolExecutionError('TARGET_UNAVAILABLE', 'Room is unavailable or inaccessible.');
			const result = await searchRoomMessages(context.userId, room, type, {
				query: asText(args.query),
				since: args.since as string | undefined,
				until: args.until as string | undefined,
				beforeId: args.beforeId as number | undefined,
				limit: Number(args.limit) || 10
			});
			if (!result)
				throw new ToolExecutionError('TARGET_UNAVAILABLE', 'Room is unavailable or inaccessible.');
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
		output: toolOutputs.get_message_context,
		description:
			'Read a message and nearby messages after checking access to its room. Use a message id from search_messages.',
		kind: 'read',
		schema: messageContextSchema,
		run: async (context, args) => {
			const messageId = Number(args.messageId);
			const result = await messageContextById(
				context.userId,
				messageId,
				Number(args.before ?? 3),
				Number(args.after ?? 3)
			);
			if (!result)
				throw new ToolExecutionError(
					'TARGET_UNAVAILABLE',
					'Message is unavailable or inaccessible.'
				);
			return {
				found: true,
				room: result.room,
				focusId: messageId,
				messages: result.messages.map(presentMessage)
			};
		}
	},
	{
		name: 'list_my_tasks',
		output: toolOutputs.list_my_tasks,
		description: "List the current user's saved personal tasks. Never creates or changes tasks.",
		kind: 'read',
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
		output: toolOutputs.search_contacts,
		description:
			'Search contacts visible to the current user by username, display name, or remark.',
		kind: 'read',
		schema: searchSchema,
		run: async (context, args) => {
			const rows = await searchVisibleContacts(context.userId, asText(args.query));
			return { contacts: rows };
		}
	},
	{
		name: 'search_groups',
		output: toolOutputs.search_groups,
		description: 'Search groups joined by the current user.',
		kind: 'read',
		schema: searchSchema,
		run: async (context, args) => {
			const rows = await searchJoinedGroups(context.userId, asText(args.query));
			return { groups: rows };
		}
	},
	{
		name: 'extract_todos',
		output: toolOutputs.extract_todos,
		description:
			'Find todo suggestions using keyword rules in text. This tool only suggests and never writes data.',
		kind: 'suggestion',
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
		output: toolOutputs.suggest_replies,
		description:
			'Suggest short replies using predefined templates. This tool never sends messages.',
		kind: 'suggestion',
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
		output: toolOutputs.search_memory,
		description:
			"Read the current user's saved preferences and facts. This is private to the current user and never reads other users' memories.",
		kind: 'read',
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
		output: toolOutputs.save_memory,
		description:
			'Save a concise private memory only when the user explicitly asks to remember, save, or keep a fact or preference. Never save secrets, passwords, API keys, or entire chat transcripts.',
		kind: 'write',
		schema: memorySaveSchema,
		run: async (context, args) => {
			const content = asText(args.content).trim();
			const category = (asText(args.category).trim() || 'preference').slice(0, 32);
			await repository.saveMemoryIdempotently([
				context.userId,
				category,
				content,
				context.confirmationId
			]);
			return { saved: true, category, content };
		}
	},
	{
		name: 'forget_memory',
		output: toolOutputs.forget_memory,
		description: 'Delete one saved memory by id after user confirmation.',
		kind: 'write',
		schema: memoryForgetSchema,
		run: async (context, args) => {
			const result = await repository.deleteOwnedMemory<WriteResult>([context.userId, args.id]);
			if (!result.affectedRows)
				throw new ToolExecutionError(
					'TARGET_UNAVAILABLE',
					'Memory is unavailable or inaccessible.'
				);
			return { deleted: result.affectedRows };
		}
	}
];

export const pomeloToolDefinitions: PomeloToolDefinition[] = pomeloToolSpecs.map(
	({ name, description, kind, schema, output }) => ({
		name,
		description,
		kind,
		inputSchema: z.toJSONSchema(schema, { io: 'input' }),
		outputSchema: z.toJSONSchema(output)
	})
);

export const executePomeloTool = async (
	context: PomeloToolContext,
	call: PomeloToolCall
): Promise<Record<string, unknown>> => {
	const spec = pomeloToolSpecs.find(item => item.name === call.name);
	if (!spec) {
		throw new ToolExecutionError('UNKNOWN_TOOL', `Unknown tool: ${call.name}`);
	}
	if (spec.kind === 'write' && !context.confirmationId) {
		throw new ToolExecutionError(
			'CONFIRMATION_REQUIRED',
			`Tool ${call.name} requires a confirmed action`
		);
	}
	if (!Number.isSafeInteger(context.userId) || context.userId <= 0)
		throw new ToolExecutionError('INVALID_ARGUMENTS', 'A valid user id is required.');
	if (
		call.args !== undefined &&
		(!call.args || typeof call.args !== 'object' || Array.isArray(call.args))
	)
		throw new ToolExecutionError('INVALID_ARGUMENTS', 'Tool arguments must be an object.');
	const parsed = spec.schema.safeParse({
		...(call.args || {}),
		...(call.room ? { room: call.room } : {})
	});
	if (!parsed.success)
		throw new ToolExecutionError(
			'INVALID_ARGUMENTS',
			parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
		);
	const run = async (): Promise<Record<string, unknown>> => {
		await assertToolRateLimit(context.userId);
		try {
			const result = await spec.run(context, parsed.data as Record<string, unknown>);
			return spec.output.parse(JSON.parse(JSON.stringify(result))) as Record<string, unknown>;
		} catch (error) {
			if (error instanceof ToolExecutionError) throw error;
			console.error(`[assistant-tool] ${call.name} failed`);
			throw new ToolExecutionError(
				'EXECUTION_FAILED',
				'Tool execution failed. Please retry later.'
			);
		}
	};
	if (call.name !== 'search_memory' || !context.memoryReads) return run();
	const args = parsed.data as { query?: string; limit?: number };
	const key = JSON.stringify([context.userId, args.query || '', args.limit ?? 8]);
	const cache = context.memoryReads;
	let pending = cache.get(key);
	if (!pending) {
		pending = run();
		cache.set(key, pending);
	}
	try {
		return structuredClone(await pending);
	} catch (error) {
		if (cache.get(key) === pending) cache.delete(key);
		throw error;
	}
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
					try {
						const result = await executePomeloTool(context, {
							name: spec.name,
							args: args as Record<string, unknown>
						});
						return JSON.stringify(result);
					} catch (error) {
						return JSON.stringify(toolErrorResult(error));
					}
				},
				{
					name: spec.name,
					description: spec.description,
					schema: spec.schema
				}
			)
		);
