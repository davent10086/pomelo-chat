import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { better_chat } from '../../utils/authenticate';
import { Query } from '../../utils/query';
import { RespData, RespError } from '../../utils/resp';
import { CommonStatus } from '../../utils/status';
import { sendConfirmedTextMessage } from '../message';

const ACTION_TTL_SECONDS = 10 * 60;
const actionPrefix = 'assistant:pending-action:';
const resultPrefix = 'assistant:action-result:';

export type PendingActionType = 'create_tasks' | 'send_message';

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

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const cacheKey = (id: string) => `${actionPrefix}${id}`;

const claimActionScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return { 'missing' } end
local action = cjson.decode(raw)
if tonumber(action.userId) ~= tonumber(ARGV[1]) then return { 'forbidden' } end
if action.status ~= 'pending' then return { action.status } end
local ttl = redis.call('TTL', KEYS[1])
if ttl <= 0 then return { 'missing' } end
action.status = 'executing'
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
	const id = randomUUID();
	const expiresAt = new Date(Date.now() + ACTION_TTL_SECONDS * 1000).toISOString();
	const value: PendingAction = { id, userId, type, payload, expiresAt, status: 'pending' };
	await better_chat.set(cacheKey(id), JSON.stringify(value), 'EX', ACTION_TTL_SECONDS);
	return { type, requiresConfirmation: true, payload, confirmationId: id, expiresAt };
};

const claimPendingAction = async (id: string, userId: number): Promise<{ state: string; action?: PendingAction }> => {
	const result = await better_chat.eval(claimActionScript, 1, cacheKey(id), String(userId)) as string[];
	if (result[0] !== 'claimed') return { state: result[0] };
	return { state: 'claimed', action: JSON.parse(result[1]) as PendingAction };
};

const cancelPendingAction = async (id: string, userId: number): Promise<string> => {
	const result = await better_chat.eval(cancelActionScript, 1, cacheKey(id), String(userId)) as string[];
	return result[0];
};

const actionResult = async (id: string, userId: number): Promise<Record<string, unknown> | null> => {
	const raw = await better_chat.get(`${resultPrefix}${id}`);
	if (!raw) return null;
	const stored = JSON.parse(raw) as { userId?: number; result?: Record<string, unknown> };
	return stored.userId === userId && stored.result ? stored.result : null;
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

const createTasks = async (userId: number, payload: Record<string, unknown>, indexes?: unknown): Promise<Record<string, unknown>> => {
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
		const result = await Query<WriteResult>(
			'INSERT INTO assistant_task (user_id, source_room, title, assignee, due) VALUES (?, ?, ?, ?, ?)',
			[userId, typeof payload.sourceRoom === 'string' ? payload.sourceRoom.slice(0, 255) : null, title, assignee, due]
		);
		created.push({ id: result.insertId, title, assignee: assignee || undefined, due: due || undefined, status: 'open' });
	}
	return { type: 'create_tasks', created };
};

const executePendingAction = async (action: PendingAction, selection?: unknown): Promise<Record<string, unknown>> => {
	if (action.type === 'create_tasks') return createTasks(action.userId, action.payload, selection);
	const room = typeof action.payload.room === 'string' ? action.payload.room : '';
	const chatType = action.payload.chatType === 'private' || action.payload.chatType === 'group' ? action.payload.chatType : null;
	const content = typeof action.payload.content === 'string' ? action.payload.content : '';
	if (!chatType) throw new Error('Invalid message target');
	await sendConfirmedTextMessage(action.userId, room, chatType, content);
	return { type: 'send_message', room, sent: true };
};

export const confirmAction = async (req: Request, res: Response): Promise<void> => {
	const confirmationId = typeof req.body?.confirmationId === 'string' ? req.body.confirmationId : '';
	if (!confirmationId) return RespError(res, CommonStatus.PARAM_ERR);
	const userId = Number(req.user!.id);
	try {
		const existing = await actionResult(confirmationId, userId);
		if (existing) return RespData(res, { ...existing, alreadyConfirmed: true });
		const claimed = await claimPendingAction(confirmationId, userId);
		if (claimed.state === 'missing' || claimed.state === 'forbidden') return RespError(res, CommonStatus.NOT_FOUND);
		if (claimed.state !== 'claimed' || !claimed.action) return RespError(res, CommonStatus.PARAM_ERR);
		const action = claimed.action;
		const result = await executePendingAction(action, req.body?.taskIndexes);
		await saveActionResult(confirmationId, userId, result, action.expiresAt);
		RespData(res, result);
	} catch (err: unknown) {
		console.error('[assistant-action] confirm failed:', errorMessage(err));
		try { await releasePendingAction(confirmationId); } catch (releaseErr: unknown) { console.error('[assistant-action] release failed:', errorMessage(releaseErr)); }
		RespError(res, CommonStatus.PARAM_ERR);
	}
};

export const cancelAction = async (req: Request, res: Response): Promise<void> => {
	const confirmationId = typeof req.body?.confirmationId === 'string' ? req.body.confirmationId : '';
	if (!confirmationId) return RespError(res, CommonStatus.PARAM_ERR);
	try {
		const state = await cancelPendingAction(confirmationId, Number(req.user!.id));
		if (state === 'missing' || state === 'forbidden') return RespError(res, CommonStatus.NOT_FOUND);
		if (state !== 'cancelled') return RespError(res, CommonStatus.PARAM_ERR);
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
