import type { RequestHandler, Request, Response, NextFunction } from 'express';

import { canDownloadFile } from '../../read-models/file-access';
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
		const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
		const token = req.headers.authorization || queryToken;
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
