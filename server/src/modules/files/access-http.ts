import type { RequestHandler, Request, Response, NextFunction } from 'express';

import { canDownloadFile } from '../../read-models/file-access';
import { better_chat } from '../../infrastructure/redis';
import { sessionDigest } from './media-access';
const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
export const createUploadAccessMiddleware =
	(
		verifyTokenWithSession: (token?: string) => Promise<import('jsonwebtoken').JwtPayload | null>,
		isAuthenticatedPayload: (
			value: import('jsonwebtoken').JwtPayload
		) => value is import('jsonwebtoken').JwtPayload & { id: number | string; username: string }
	): RequestHandler =>
	async (req: Request, res: Response, next: NextFunction) => {
		let token = req.headers.authorization;
		try {
			if (!token && typeof req.query.access === 'string' && /^[a-f0-9-]{36}$/.test(req.query.access) && ['GET', 'HEAD'].includes(req.method)) {
				const raw = await better_chat.get(`media:access:${req.query.access}`);
				const access = raw ? JSON.parse(raw) as { path: string; userId: number | string; username: string; digest: string } : null;
				if (access?.path === `/uploads${req.path}`) {
					const current = await better_chat.get(`token:${access.username}`);
					if (current && sessionDigest(current) === access.digest) token = current;
				}
			}
		} catch { res.status(503).end(); return; }
		const payload = await verifyTokenWithSession(token);
		if (!payload) {
			res.status(401).end();
			return;
		}
		if (!isAuthenticatedPayload(payload)) {
			res.status(401).end();
			return;
		}
		const storagePath = `/uploads${req.path}`;
		try {
			const allowed = await canDownloadFile(storagePath, payload.id);
			if (!allowed) {
				res.status(404).end();
				return;
			}
		} catch (error: unknown) {
			console.error('[upload] authorization lookup failed:', errorMessage(error));
			res.status(503).end();
			return;
		}
		req.user = payload;
		next();
	};
