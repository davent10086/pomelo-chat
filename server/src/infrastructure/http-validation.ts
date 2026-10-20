import { z } from 'zod';
import type { RequestHandler } from 'express';
import { RespError } from './http-response';
import { CommonStatus } from '../shared/status';

const id = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)))]);
const text = (max: number) => z.string().max(max);
const sequence = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/).refine(value => Number.isSafeInteger(Number(value)))]);
const room = text(128).min(1), chatType = z.enum(['private', 'group']);
const invitee = z.object({ user_id: id, username: text(50).min(1) });
const schemas: Record<string, z.ZodType> = {
	'/auth/login': z.object({ username: text(50).min(1), password: text(72).min(1) }),
	'/auth/register': z.object({ username: text(50).min(1), password: text(72).min(1), phone: z.string().regex(/^1[3-9]\d{9}$/), avatar: text(2048).optional() }),
	'/auth/update_info': z.object({ phone: z.string().regex(/^1[3-9]\d{9}$/), name: text(255).optional(), signature: text(5000).optional(), avatar: text(255).optional() }),
	'/auth/forget_password': z.object({ currentPassword: text(72).min(1), password: text(72).min(1) }),
	'/friend/friend_id': z.object({ id }),
	'/friend/add_friend': z.object({ id, username: text(50).min(1) }),
	'/group/group_info': z.object({ group_id: id }),
	'/group/group_member': z.object({ group_id: id, room }),
	'/friend/create_group': z.object({ name: text(50).trim().min(1) }),
	'/friend/update_friend': z.object({ friend_id: id, group_id: id, remark: text(50) }),
	'/friend/search_user': z.object({ username: text(255).min(1), afterId: sequence.optional(), limit: id.optional() }),
	'/group/search_group': z.object({ name: text(255).min(1), afterId: sequence.optional(), limit: id.optional() }),
	'/group/add_group': z.object({ group_id: id }),
	'/group/create_group': z.object({ name: text(50).trim().min(1), members: z.array(invitee).max(1000), avatar: text(255).nullable().optional(), announcement: text(5000).nullable().optional() }),
	'/group/invite_friend': z.object({ groupId: id, invitationList: z.array(invitee).min(1).max(1000) }),
	'/message/history': z.object({ room, type: chatType, beforeId: id.optional(), afterSeq: sequence.optional(), limit: id.optional() }),
	'/message/read': z.object({ room, type: chatType, roomSeq: sequence }),
	'/message/resolve': z.object({ room, type: chatType, clientMsgIds: z.array(text(64).min(8)).max(100) }),
	'/message/context': z.object({ room, type: chatType, messageId: id }),
	'/file/verify_file': z.object({ fileHash: z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i), totalCount: id, extname: text(11).min(1) }),
	'/file/merge_chunk': z.object({ fileHash: text(64).min(32), extname: text(11).min(1), uploadToken: text(128).min(1) }),
	'/rtc/invite': z.object({ room, type: chatType, mode: z.enum(['private_audio', 'private_video', 'group_audio', 'group_video']) }),
	'/rtc/join-token': z.object({ room, type: chatType, callId: text(64).min(1) }),
	'/rtc/accept': z.object({ callId: text(64).min(1) }),
	'/rtc/end': z.object({ callId: text(64).min(1) }),
	'/assistant/actions/confirm': z.object({ confirmationId: text(128).min(1), taskIndexes: z.array(z.number().int().nonnegative()).min(1).max(100).optional() }),
	'/assistant/actions/cancel': z.object({ confirmationId: text(128).min(1) }),
	'/assistant/messages/prepare': z.object({ room, chatType, content: text(8000).min(1) })
};

/** Reject ambiguous parser shapes before any application/repository coercion. */
export const validateHttpInput: RequestHandler = (req, res, next) => {
	if (Object.values(req.query).some(value => typeof value !== 'string')) {
		RespError(res, CommonStatus.PARAM_ERR); return;
	}
	const schema = schemas[req.path];
	const queryRoute = ['/friend/friend_id', '/friend/search_user', '/group/search_group', '/group/group_info', '/group/group_member', '/message/history', '/message/context'].includes(req.path);
	const applicable = queryRoute ? req.method === 'GET' : req.method === 'POST';
	if (schema && applicable && !schema.safeParse(queryRoute ? req.query : req.body).success) {
		RespError(res, CommonStatus.PARAM_ERR); return;
	}
	next();
};
