export interface ConfirmActionInput {
	confirmationId?: unknown;
	taskIndexes?: unknown;
}
export interface GetActionStatusInput {
	id?: unknown;
}
export interface CancelActionInput {
	confirmationId?: unknown;
}
export interface UpdateTaskInput {
	id?: unknown;
	completed?: unknown;
}
import * as repository from './repository';
import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
import { randomUUID } from 'crypto';

import { better_chat } from '../../infrastructure/redis';
import { CommonStatus } from '../../shared/status';
import { sendConfirmedTextMessage } from '../messaging/public';
import { externalMcpManager } from './adapters/external-mcp';
import { executePomeloTool, isSensitiveMemoryContent } from './tools/pomelo-tools';

const ACTION_TTL_SECONDS = 10 * 60;
const actionPrefix = 'assistant:pending-action:';
const resultPrefix = 'assistant:action-result:';

export type PendingActionType =
	'create_tasks' | 'send_message' | 'external_mcp' | 'save_memory' | 'forget_memory';

export interface AgentAction {
	type: PendingActionType | 'reply_suggestion';
	requiresConfirmation: boolean;
	payload: Record<string, unknown>;
	confirmationId?: string;
	expiresAt?: string;
}

interface PendingAction {
	id: string;
	userId: number;
	type: PendingActionType;
	payload: Record<string, unknown>;
	expiresAt: string;
	status: 'pending' | 'executing';
	selection?: number[] | null;
}

interface AssistantTaskRow {
	id: number;
	title: string;
	assignee: string | null;
	due: string | null;
	status: 'open' | 'completed';
	sourceRoom: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
}

interface WriteResult {
	insertId?: number;
	affectedRows: number;
}

interface ActionRow {
	id: string;
	userId: number;
	type: PendingActionType;
	payload: string | Record<string, unknown>;
	selection: string | number[] | null;
	result: string | Record<string, unknown> | null;
	status: 'pending' | 'executing' | 'completed' | 'cancelled';
	expiresAt: Date | string;
	leaseUntil: Date | string | null;
}

const decode = <T>(value: string | T | null): T | null =>
	value === null ? null : typeof value === 'string' ? (JSON.parse(value) as T) : value;
const actionRows = (id: string, userId: number) =>
	repository.findOwnedAction<ActionRow[]>([id, userId]);
const publicState = (row: ActionRow) => ({
	confirmationId: row.id,
	type: row.type,
	status:
		row.status === 'pending' && new Date(row.expiresAt).getTime() <= Date.now()
			? 'expired'
			: row.status,
	retryable:
		row.status === 'executing' &&
		(!row.leaseUntil || new Date(row.leaseUntil).getTime() <= Date.now()),
	result: decode<Record<string, unknown>>(row.result)
});

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const cacheKey = (id: string) => `${actionPrefix}${id}`;

const claimActionScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return { 'missing' } end
local action = cjson.decode(raw)
if tonumber(action.userId) ~= tonumber(ARGV[1]) then return { 'forbidden' } end
if action.status ~= 'pending' then return { action.status, cjson.encode(action) } end
local ttl = redis.call('TTL', KEYS[1])
if ttl <= 0 then return { 'missing' } end
action.status = 'executing'
action.selection = cjson.decode(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(action), 'EX', ttl)
return { 'claimed', cjson.encode(action) }
`;

const cancelActionScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return { 'missing' } end
local action = cjson.decode(raw)
if tonumber(action.userId) ~= tonumber(ARGV[1]) then return { 'forbidden' } end
if action.status ~= 'pending' then return { action.status } end
redis.call('DEL', KEYS[1])
return { 'cancelled' }
`;

const completeActionScript = `
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
redis.call('DEL', KEYS[1])
return 1
`;

const releaseActionScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local action = cjson.decode(raw)
if action.status ~= 'executing' then return 0 end
local ttl = redis.call('TTL', KEYS[1])
if ttl <= 0 then return 0 end
action.status = 'pending'
redis.call('SET', KEYS[1], cjson.encode(action), 'EX', ttl)
return 1
`;

export const createPendingAction = async (
	userId: number,
	type: PendingActionType,
	payload: Record<string, unknown>
): Promise<AgentAction> => {
	if (type === 'save_memory') {
		const content = typeof payload.content === 'string' ? payload.content.trim() : '';
		const category = payload.category;
		if (
			!content ||
			content.length > 1000 ||
			isSensitiveMemoryContent(content) ||
			(category !== undefined && (typeof category !== 'string' || category.length > 32))
		) {
			throw new Error('Invalid memory proposal');
		}
		payload = { content, category: category || 'preference' };
	}
	if (type === 'forget_memory') {
		const memoryId = payload.id;
		if (typeof memoryId !== 'number' || !Number.isSafeInteger(memoryId) || memoryId <= 0)
			throw new Error('Invalid memory deletion');
		const target = await repository.findOwnedMemory<Array<{ id: number; content: string }>>([
			userId,
			memoryId
		]);
		if (!target.length) throw new Error('Memory not found');
		payload = { id: memoryId, content: target[0].content };
	}
	const id = randomUUID();
	const expiresAt = new Date(Date.now() + ACTION_TTL_SECONDS * 1000).toISOString();
	const value: PendingAction = { id, userId, type, payload, expiresAt, status: 'pending' };
	await repository.insertPendingAction([
		id,
		userId,
		type,
		JSON.stringify(payload),
		new Date(expiresAt).getTime() / 1000
	]);
	await better_chat.set(cacheKey(id), JSON.stringify(value), 'EX', ACTION_TTL_SECONDS);
	return { type, requiresConfirmation: true, payload, confirmationId: id, expiresAt };
};

const claimPendingAction = async (
	id: string,
	userId: number,
	selection: number[] | null
): Promise<{ state: string; action?: PendingAction }> => {
	const result = (await better_chat.eval(
		claimActionScript,
		1,
		cacheKey(id),
		String(userId),
		JSON.stringify(selection)
	)) as string[];
	return {
		state: result[0],
		action: result[1] ? (JSON.parse(result[1]) as PendingAction) : undefined
	};
};

const cancelPendingAction = async (id: string, userId: number): Promise<string> => {
	const result = (await better_chat.eval(
		cancelActionScript,
		1,
		cacheKey(id),
		String(userId)
	)) as string[];
	return result[0];
};

const saveActionResult = async (
	id: string,
	userId: number,
	value: Record<string, unknown>,
	expiresAt: string
): Promise<void> => {
	const ttl = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
	await better_chat.eval(
		completeActionScript,
		2,
		cacheKey(id),
		`${resultPrefix}${id}`,
		JSON.stringify({ userId, result: value }),
		String(ttl)
	);
};

const releasePendingAction = async (id: string): Promise<void> => {
	await better_chat.eval(releaseActionScript, 1, cacheKey(id));
};

const taskRows = async (userId: number): Promise<AssistantTaskRow[]> => {
	const rows = await repository.listOwnedTasks<AssistantTaskRow[]>([userId]);
	return rows;
};

const createTasks = async (
	userId: number,
	payload: Record<string, unknown>,
	actionId: string,
	indexes?: unknown
): Promise<Record<string, unknown>> => {
	const todos = Array.isArray(payload.todos) ? payload.todos : [];
	const selected = Array.isArray(indexes)
		? new Set(
				indexes.filter(
					(value): value is number => Number.isInteger(value) && value >= 0 && value < todos.length
				)
			)
		: new Set(todos.map((_value, index) => index));
	const created: Array<Record<string, unknown>> = [];
	for (const index of selected) {
		const todo = todos[index] as Record<string, unknown>;
		const title = typeof todo?.title === 'string' ? todo.title.trim().slice(0, 500) : '';
		if (!title) continue;
		const assignee =
			typeof todo.assignee === 'string' ? todo.assignee.trim().slice(0, 255) || null : null;
		const due = typeof todo.due === 'string' ? todo.due.trim().slice(0, 255) || null : null;
		await repository.insertTaskIdempotently<WriteResult>([
			userId,
			typeof payload.sourceRoom === 'string' ? payload.sourceRoom.slice(0, 255) : null,
			actionId,
			index,
			title,
			assignee,
			due
		]);
		const rows = await repository.findTaskByConfirmation<Array<{ id: number }>>([
			userId,
			actionId,
			index
		]);
		created.push({
			id: rows[0].id,
			title,
			assignee: assignee || undefined,
			due: due || undefined,
			status: 'open'
		});
	}
	return { type: 'create_tasks', created };
};

const executePendingAction = async (
	action: PendingAction,
	selection?: unknown
): Promise<Record<string, unknown>> => {
	if (action.type === 'create_tasks')
		return createTasks(action.userId, action.payload, action.id, selection);
	if (action.type === 'save_memory') {
		const result = await executePomeloTool(
			{ userId: action.userId, confirmationId: action.id },
			{ name: 'save_memory', args: action.payload }
		);
		if (result.saved !== true) throw new Error('Memory was not saved');
		return { type: 'save_memory', ...result };
	}
	if (action.type === 'forget_memory') {
		const result = await executePomeloTool(
			{ userId: action.userId, confirmationId: action.id },
			{ name: 'forget_memory', args: action.payload }
		);
		return { type: 'forget_memory', ...result };
	}
	if (action.type === 'external_mcp') {
		const name = typeof action.payload.name === 'string' ? action.payload.name : '';
		const args = action.payload.args;
		if (!name || !args || typeof args !== 'object' || Array.isArray(args))
			throw new Error('Invalid external MCP action');
		const result = await externalMcpManager.executeConfirmedTool(
			name,
			args as Record<string, unknown>,
			action.userId,
			action.id
		);
		return { type: 'external_mcp', name, result: result as Record<string, unknown> };
	}
	const room = typeof action.payload.room === 'string' ? action.payload.room : '';
	const chatType =
		action.payload.chatType === 'private' || action.payload.chatType === 'group'
			? action.payload.chatType
			: null;
	const content = typeof action.payload.content === 'string' ? action.payload.content : '';
	if (!chatType) throw new Error('Invalid message target');
	await sendConfirmedTextMessage(action.userId, room, chatType, content, action.id);
	return { type: 'send_message', room, sent: true };
};

export const confirmAction = async (
	actor: Actor,
	parameters: ConfirmActionInput
): Promise<Outcome> => {
	const confirmationId =
		typeof parameters.confirmationId === 'string' ? parameters.confirmationId : '';
	if (!confirmationId) return failure(CommonStatus.PARAM_ERR);
	const userId = Number(actor.id);
	try {
		const row = (await actionRows(confirmationId, userId))[0];
		if (!row) return failure(CommonStatus.NOT_FOUND);
		if (row.status === 'completed')
			return success({
				...(decode<Record<string, unknown>>(row.result) || {}),
				...publicState(row),
				alreadyConfirmed: true
			});
		if (row.status === 'cancelled') return failure(CommonStatus.NOT_FOUND);
		const now = Date.now();
		let selection: number[] | null = decode<number[]>(row.selection);
		if (row.status === 'pending') {
			if (new Date(row.expiresAt).getTime() <= now) return success(publicState(row));
			const todos = Array.isArray(decode<Record<string, unknown>>(row.payload)?.todos)
				? (decode<Record<string, unknown>>(row.payload)!.todos as unknown[])
				: [];
			if (row.type === 'create_tasks' && parameters.taskIndexes !== undefined) {
				if (
					!Array.isArray(parameters.taskIndexes) ||
					!parameters.taskIndexes.length ||
					parameters.taskIndexes.some(
						(index: unknown) =>
							!Number.isInteger(index) || Number(index) < 0 || Number(index) >= todos.length
					)
				) {
					return failure(CommonStatus.PARAM_ERR);
				}
				selection = [...new Set(parameters.taskIndexes as number[])];
			}
			let claimed = await claimPendingAction(confirmationId, userId, selection);
			if (claimed.state === 'missing') {
				const ttl = Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 1000);
				if (ttl > 0) {
					const restored: PendingAction = {
						id: row.id,
						userId,
						type: row.type,
						payload: decode<Record<string, unknown>>(row.payload) || {},
						expiresAt: new Date(row.expiresAt).toISOString(),
						status: 'pending'
					};
					await better_chat.set(
						cacheKey(confirmationId),
						JSON.stringify(restored),
						'EX',
						ttl,
						'NX'
					);
					claimed = await claimPendingAction(confirmationId, userId, selection);
				}
			}
			if (claimed.state === 'missing' || claimed.state === 'forbidden')
				return failure(CommonStatus.NOT_FOUND);
			if (claimed.state !== 'claimed' && claimed.state !== 'executing')
				return failure(CommonStatus.PARAM_ERR);
			selection = claimed.action?.selection ?? null;
			const changed = await repository.claimPendingAction<WriteResult>([
				selection === null ? null : JSON.stringify(selection),
				confirmationId,
				userId
			]);
			if (!changed.affectedRows) {
				const latest = (await actionRows(confirmationId, userId))[0];
				return latest ? success(publicState(latest)) : failure(CommonStatus.NOT_FOUND);
			}
		} else {
			if (row.leaseUntil && new Date(row.leaseUntil).getTime() > now)
				return success(publicState(row));
			const changed = await repository.reclaimExecutingAction<WriteResult>([
				confirmationId,
				userId
			]);
			if (!changed.affectedRows) return success(publicState(row));
		}
		const payload = decode<Record<string, unknown>>(row.payload) || {};
		const action: PendingAction = {
			id: row.id,
			userId,
			type: row.type,
			payload,
			expiresAt: new Date(row.expiresAt).toISOString(),
			status: 'executing'
		};
		const result = await executePendingAction(action, selection);
		await repository.completeAction([JSON.stringify(result), confirmationId, userId]);
		try {
			await saveActionResult(confirmationId, userId, result, action.expiresAt);
		} catch (cacheError) {
			console.error('[assistant-action] result cache failed:', errorMessage(cacheError));
		}
		return success({ ...result, confirmationId, status: 'completed', result });
	} catch (err: unknown) {
		console.error('[assistant-action] confirm failed:', errorMessage(err));
		try {
			const latest = (await actionRows(confirmationId, userId))[0];
			if (latest?.status === 'pending') await releasePendingAction(confirmationId);
			if (latest?.status === 'executing')
				await repository.expireExecutionLease([confirmationId, userId]);
		} catch (releaseErr: unknown) {
			console.error('[assistant-action] release failed:', errorMessage(releaseErr));
		}
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const getActionStatus = async (
	actor: Actor,
	parameters: GetActionStatusInput
): Promise<Outcome> => {
	try {
		const row = (await actionRows(String(parameters.id || ''), Number(actor.id)))[0];
		if (!row) return failure(CommonStatus.NOT_FOUND);
		return success(publicState(row));
	} catch (err: unknown) {
		console.error('[assistant-action] status failed:', errorMessage(err));
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const cancelAction = async (
	actor: Actor,
	parameters: CancelActionInput
): Promise<Outcome> => {
	const confirmationId =
		typeof parameters.confirmationId === 'string' ? parameters.confirmationId : '';
	if (!confirmationId) return failure(CommonStatus.PARAM_ERR);
	try {
		const userId = Number(actor.id);
		const changed = await repository.cancelPendingAction<WriteResult>([confirmationId, userId]);
		if (!changed.affectedRows) {
			const row = (await actionRows(confirmationId, userId))[0];
			return failure(
				!row || row.status === 'cancelled' ? CommonStatus.NOT_FOUND : CommonStatus.PARAM_ERR
			);
		}
		try {
			await cancelPendingAction(confirmationId, userId);
		} catch (cacheError) {
			console.error('[assistant-action] cancel cache failed:', errorMessage(cacheError));
		}
		return success({ cancelled: true, confirmationId });
	} catch (err: unknown) {
		console.error('[assistant-action] cancel failed:', errorMessage(err));
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const listTasks = async (actor: Actor): Promise<Outcome> => {
	try {
		return success({ tasks: await taskRows(Number(actor.id)) });
	} catch (err: unknown) {
		console.error('[assistant-task] list failed:', errorMessage(err));
		return failure(CommonStatus.SERVER_ERR);
	}
};

export const updateTask = async (actor: Actor, parameters: UpdateTaskInput): Promise<Outcome> => {
	const id = Number(parameters.id);
	const completed = parameters.completed;
	if (!Number.isInteger(id) || typeof completed !== 'boolean')
		return failure(CommonStatus.PARAM_ERR);
	try {
		const result = await repository.updateOwnedTaskStatus<WriteResult>([
			completed ? 'completed' : 'open',
			id,
			Number(actor.id)
		]);
		if (!result.affectedRows) return failure(CommonStatus.NOT_FOUND);
		return success({ id, status: completed ? 'completed' : 'open' });
	} catch (err: unknown) {
		console.error('[assistant-task] update failed:', errorMessage(err));
		return failure(CommonStatus.SERVER_ERR);
	}
};
