import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { better_chat } from '../../utils/authenticate';
import { Query } from '../../utils/query';
import { RespData, RespError } from '../../utils/resp';
import { CommonStatus } from '../../utils/status';
import { sendConfirmedTextMessage } from '../message';
import { externalMcpManager } from './tools/external-mcp';
import { executePomeloTool, isSensitiveMemoryContent } from './tools/pomelo-tools';

const ACTION_TTL_SECONDS = 10 * 60;
const actionPrefix = 'assistant:pending-action:';
const resultPrefix = 'assistant:action-result:';

export type PendingActionType = 'create_tasks' | 'send_message' | 'external_mcp' | 'save_memory' | 'forget_memory';

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

const decode = <T>(value: string | T | null): T | null => value === null ? null : typeof value === 'string' ? JSON.parse(value) as T : value;
const actionRows = (id: string, userId: number) => Query<ActionRow[]>(
	`SELECT id, user_id AS userId, type, payload, selection, result, status,
	 expires_at AS expiresAt, lease_until AS leaseUntil FROM assistant_action WHERE id = ? AND user_id = ?`,
	[id, userId]
);
const publicState = (row: ActionRow) => ({
	confirmationId: row.id,
	type: row.type,
	status: row.status === 'pending' && new Date(row.expiresAt).getTime() <= Date.now() ? 'expired' : row.status,
	retryable: row.status === 'executing' && (!row.leaseUntil || new Date(row.leaseUntil).getTime() <= Date.now()),
	result: decode<Record<string, unknown>>(row.result)
});

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
		if (!content || content.length > 1000 || isSensitiveMemoryContent(content) ||
			(category !== undefined && (typeof category !== 'string' || category.length > 32))) {
			throw new Error('Invalid memory proposal');
		}
		payload = { content, category: category || 'preference' };
	}
	if (type === 'forget_memory') {
		const memoryId = payload.id;
		if (typeof memoryId !== 'number' || !Number.isSafeInteger(memoryId) || memoryId <= 0) throw new Error('Invalid memory deletion');
		const target = await Query<Array<{ id: number; content: string }>>(
			'SELECT id, content FROM assistant_memory WHERE user_id = ? AND id = ? LIMIT 1', [userId, memoryId]
		);
		if (!target.length) throw new Error('Memory not found');
		payload = { id: memoryId, content: target[0].content };
	}
	const id = randomUUID();
	const expiresAt = new Date(Date.now() + ACTION_TTL_SECONDS * 1000).toISOString();
	const value: PendingAction = { id, userId, type, payload, expiresAt, status: 'pending' };
	await Query(
		`INSERT INTO assistant_action (id, user_id, type, payload, expires_at) VALUES (?, ?, ?, ?, FROM_UNIXTIME(?))`,
		[id, userId, type, JSON.stringify(payload), new Date(expiresAt).getTime() / 1000]
	);
	await better_chat.set(cacheKey(id), JSON.stringify(value), 'EX', ACTION_TTL_SECONDS);
	return { type, requiresConfirmation: true, payload, confirmationId: id, expiresAt };
};

const claimPendingAction = async (id: string, userId: number, selection: number[] | null): Promise<{ state: string; action?: PendingAction }> => {
	const result = await better_chat.eval(claimActionScript, 1, cacheKey(id), String(userId), JSON.stringify(selection)) as string[];
	return { state: result[0], action: result[1] ? JSON.parse(result[1]) as PendingAction : undefined };
};

const cancelPendingAction = async (id: string, userId: number): Promise<string> => {
	const result = await better_chat.eval(cancelActionScript, 1, cacheKey(id), String(userId)) as string[];
	return result[0];
};

const saveActionResult = async (id: string, userId: number, value: Record<string, unknown>, expiresAt: string): Promise<void> => {
	const ttl = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
	await better_chat.eval(completeActionScript, 2, cacheKey(id), `${resultPrefix}${id}`, JSON.stringify({ userId, result: value }), String(ttl));
};

const releasePendingAction = async (id: string): Promise<void> => {
	await better_chat.eval(releaseActionScript, 1, cacheKey(id));
};

const taskRows = async (userId: number): Promise<AssistantTaskRow[]> => {
	const rows = await Query<AssistantTaskRow[]>(
		`SELECT id, title, assignee, due, status, source_room AS sourceRoom, created_at AS createdAt, updated_at AS updatedAt
		 FROM assistant_task WHERE user_id = ? ORDER BY status ASC, updated_at DESC`,
		[userId]
	);
	return rows;
};

const createTasks = async (userId: number, payload: Record<string, unknown>, actionId: string, indexes?: unknown): Promise<Record<string, unknown>> => {
	const todos = Array.isArray(payload.todos) ? payload.todos : [];
	const selected = Array.isArray(indexes)
		? new Set(indexes.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < todos.length))
		: new Set(todos.map((_value, index) => index));
	const created: Array<Record<string, unknown>> = [];
	for (const index of selected) {
		const todo = todos[index] as Record<string, unknown>;
		const title = typeof todo?.title === 'string' ? todo.title.trim().slice(0, 500) : '';
		if (!title) continue;
		const assignee = typeof todo.assignee === 'string' ? todo.assignee.trim().slice(0, 255) || null : null;
		const due = typeof todo.due === 'string' ? todo.due.trim().slice(0, 255) || null : null;
		await Query<WriteResult>(
			`INSERT INTO assistant_task (user_id, source_room, confirmation_id, source_index, title, assignee, due)
			 VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
			[userId, typeof payload.sourceRoom === 'string' ? payload.sourceRoom.slice(0, 255) : null, actionId, index, title, assignee, due]
		);
		const rows = await Query<Array<{ id: number }>>('SELECT id FROM assistant_task WHERE user_id = ? AND confirmation_id = ? AND source_index = ?', [userId, actionId, index]);
		created.push({ id: rows[0].id, title, assignee: assignee || undefined, due: due || undefined, status: 'open' });
	}
	return { type: 'create_tasks', created };
};

const executePendingAction = async (action: PendingAction, selection?: unknown): Promise<Record<string, unknown>> => {
	if (action.type === 'create_tasks') return createTasks(action.userId, action.payload, action.id, selection);
	if (action.type === 'save_memory') {
		const result = await executePomeloTool({ userId: action.userId, confirmationId: action.id }, { name: 'save_memory', args: action.payload });
		if (result.saved !== true) throw new Error('Memory was not saved');
		return { type: 'save_memory', ...result };
	}
	if (action.type === 'forget_memory') {
		const result = await executePomeloTool({ userId: action.userId, confirmationId: action.id }, { name: 'forget_memory', args: action.payload });
		return { type: 'forget_memory', ...result };
	}
	if (action.type === 'external_mcp') {
		const name = typeof action.payload.name === 'string' ? action.payload.name : '';
		const args = action.payload.args;
		if (!name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid external MCP action');
		const result = await externalMcpManager.executeConfirmedTool(name, args as Record<string, unknown>, action.userId, action.id);
		return { type: 'external_mcp', name, result: result as Record<string, unknown> };
	}
	const room = typeof action.payload.room === 'string' ? action.payload.room : '';
	const chatType = action.payload.chatType === 'private' || action.payload.chatType === 'group' ? action.payload.chatType : null;
	const content = typeof action.payload.content === 'string' ? action.payload.content : '';
	if (!chatType) throw new Error('Invalid message target');
	await sendConfirmedTextMessage(action.userId, room, chatType, content, action.id);
	return { type: 'send_message', room, sent: true };
};

export const confirmAction = async (req: Request, res: Response): Promise<void> => {
	const confirmationId = typeof req.body?.confirmationId === 'string' ? req.body.confirmationId : '';
	if (!confirmationId) return RespError(res, CommonStatus.PARAM_ERR);
	const userId = Number(req.user!.id);
	try {
		const row = (await actionRows(confirmationId, userId))[0];
		if (!row) return RespError(res, CommonStatus.NOT_FOUND);
		if (row.status === 'completed') return RespData(res, { ...(decode<Record<string, unknown>>(row.result) || {}), ...publicState(row), alreadyConfirmed: true });
		if (row.status === 'cancelled') return RespError(res, CommonStatus.NOT_FOUND);
		const now = Date.now();
		let selection: number[] | null = decode<number[]>(row.selection);
		if (row.status === 'pending') {
			if (new Date(row.expiresAt).getTime() <= now) return RespData(res, publicState(row));
			const todos = Array.isArray(decode<Record<string, unknown>>(row.payload)?.todos)
				? decode<Record<string, unknown>>(row.payload)!.todos as unknown[] : [];
			if (row.type === 'create_tasks' && req.body?.taskIndexes !== undefined) {
				if (!Array.isArray(req.body.taskIndexes) || !req.body.taskIndexes.length ||
					req.body.taskIndexes.some((index: unknown) => !Number.isInteger(index) || Number(index) < 0 || Number(index) >= todos.length)) {
					return RespError(res, CommonStatus.PARAM_ERR);
				}
				selection = [...new Set(req.body.taskIndexes as number[])];
			}
			let claimed = await claimPendingAction(confirmationId, userId, selection);
			if (claimed.state === 'missing') {
				const ttl = Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 1000);
				if (ttl > 0) {
					const restored: PendingAction = {
						id: row.id, userId, type: row.type,
						payload: decode<Record<string, unknown>>(row.payload) || {},
						expiresAt: new Date(row.expiresAt).toISOString(), status: 'pending'
					};
					await better_chat.set(cacheKey(confirmationId), JSON.stringify(restored), 'EX', ttl, 'NX');
					claimed = await claimPendingAction(confirmationId, userId, selection);
				}
			}
			if (claimed.state === 'missing' || claimed.state === 'forbidden') return RespError(res, CommonStatus.NOT_FOUND);
			if (claimed.state !== 'claimed' && claimed.state !== 'executing') return RespError(res, CommonStatus.PARAM_ERR);
			selection = claimed.action?.selection ?? null;
			const changed = await Query<WriteResult>(
				`UPDATE assistant_action SET status = 'executing', selection = ?, lease_until = DATE_ADD(NOW(), INTERVAL 45 SECOND)
				 WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > NOW()`,
				[selection === null ? null : JSON.stringify(selection), confirmationId, userId]
			);
			if (!changed.affectedRows) {
				const latest = (await actionRows(confirmationId, userId))[0];
				return latest ? RespData(res, publicState(latest)) : RespError(res, CommonStatus.NOT_FOUND);
			}
		} else {
			if (row.leaseUntil && new Date(row.leaseUntil).getTime() > now) return RespData(res, publicState(row));
			const changed = await Query<WriteResult>(
				`UPDATE assistant_action SET lease_until = DATE_ADD(NOW(), INTERVAL 45 SECOND)
				 WHERE id = ? AND user_id = ? AND status = 'executing' AND (lease_until IS NULL OR lease_until <= NOW())`,
				[confirmationId, userId]
			);
			if (!changed.affectedRows) return RespData(res, publicState(row));
		}
		const payload = decode<Record<string, unknown>>(row.payload) || {};
		const action: PendingAction = { id: row.id, userId, type: row.type, payload, expiresAt: new Date(row.expiresAt).toISOString(), status: 'executing' };
		const result = await executePendingAction(action, selection);
		await Query(`UPDATE assistant_action SET status = 'completed', result = ?, lease_until = NULL WHERE id = ? AND user_id = ?`, [JSON.stringify(result), confirmationId, userId]);
		try { await saveActionResult(confirmationId, userId, result, action.expiresAt); } catch (cacheError) { console.error('[assistant-action] result cache failed:', errorMessage(cacheError)); }
		RespData(res, { ...result, confirmationId, status: 'completed', result });
	} catch (err: unknown) {
		console.error('[assistant-action] confirm failed:', errorMessage(err));
		try {
			const latest = (await actionRows(confirmationId, userId))[0];
			if (latest?.status === 'pending') await releasePendingAction(confirmationId);
			if (latest?.status === 'executing') await Query(`UPDATE assistant_action SET lease_until = NOW() WHERE id = ? AND user_id = ? AND status = 'executing'`, [confirmationId, userId]);
		} catch (releaseErr: unknown) { console.error('[assistant-action] release failed:', errorMessage(releaseErr)); }
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

export const getActionStatus = async (req: Request, res: Response): Promise<void> => {
	try {
		const row = (await actionRows(String(req.params.id || ''), Number(req.user!.id)))[0];
		if (!row) return RespError(res, CommonStatus.NOT_FOUND);
		RespData(res, publicState(row));
	} catch (err: unknown) {
		console.error('[assistant-action] status failed:', errorMessage(err));
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

export const cancelAction = async (req: Request, res: Response): Promise<void> => {
	const confirmationId = typeof req.body?.confirmationId === 'string' ? req.body.confirmationId : '';
	if (!confirmationId) return RespError(res, CommonStatus.PARAM_ERR);
	try {
		const userId = Number(req.user!.id);
		const changed = await Query<WriteResult>(
			`UPDATE assistant_action SET status = 'cancelled'
			 WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > NOW()`,
			[confirmationId, userId]
		);
		if (!changed.affectedRows) {
			const row = (await actionRows(confirmationId, userId))[0];
			return RespError(res, !row || row.status === 'cancelled' ? CommonStatus.NOT_FOUND : CommonStatus.PARAM_ERR);
		}
		try { await cancelPendingAction(confirmationId, userId); } catch (cacheError) { console.error('[assistant-action] cancel cache failed:', errorMessage(cacheError)); }
		RespData(res, { cancelled: true, confirmationId });
	} catch (err: unknown) {
		console.error('[assistant-action] cancel failed:', errorMessage(err));
		RespError(res, CommonStatus.SERVER_ERR);
	}
};

export const listTasks = async (req: Request, res: Response): Promise<void> => {
	try { RespData(res, { tasks: await taskRows(Number(req.user!.id)) }); }
	catch (err: unknown) { console.error('[assistant-task] list failed:', errorMessage(err)); RespError(res, CommonStatus.SERVER_ERR); }
};

export const updateTask = async (req: Request, res: Response): Promise<void> => {
	const id = Number(req.params.id);
	const completed = req.body?.completed;
	if (!Number.isInteger(id) || typeof completed !== 'boolean') return RespError(res, CommonStatus.PARAM_ERR);
	try {
		const result = await Query<WriteResult>('UPDATE assistant_task SET status = ? WHERE id = ? AND user_id = ?', [completed ? 'completed' : 'open', id, Number(req.user!.id)]);
		if (!result.affectedRows) return RespError(res, CommonStatus.NOT_FOUND);
		RespData(res, { id, status: completed ? 'completed' : 'open' });
	} catch (err: unknown) { console.error('[assistant-task] update failed:', errorMessage(err)); RespError(res, CommonStatus.SERVER_ERR); }
};
