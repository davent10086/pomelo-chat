import { createHash, randomUUID } from 'crypto';
import { better_chat } from '../../infrastructure/redis';
import { canDownloadFile } from '../../read-models/file-access';
import type { Actor } from '../../shared/actor';
import { success, failure } from '../../shared/outcome';
import { CommonStatus } from '../../shared/status';

export const sessionDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export const prepareMediaAccess = async (actor: Actor, path: unknown, authorization?: string) => {
	if (typeof path !== 'string' || !/^\/uploads\/[1-9]\d*\/[a-z]+\/[a-zA-Z0-9._-]+$/.test(path) || path.includes('..')) return failure(CommonStatus.PARAM_ERR);
	const token = authorization?.replace(/^Bearer /, '');
	if (!token) return failure(CommonStatus.TOKEN_ERR);
	try {
		if (!(await canDownloadFile(path, actor.id))) return failure(CommonStatus.NOT_FOUND);
		const access = randomUUID();
		await better_chat.set(`media:access:${access}`, JSON.stringify({ path, userId: actor.id, username: actor.username, digest: sessionDigest(token) }), 'EX', 300);
		return success({ path, access, expiresIn: 300 });
	} catch { return failure(CommonStatus.CONNECTION_ERR); }
};
