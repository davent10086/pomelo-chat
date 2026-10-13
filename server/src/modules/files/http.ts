import type { Request, Response } from 'express';
import { respond } from '../../infrastructure/http-outcome';
import type { Actor } from '../../shared/actor';
export const createHttpHandlers = (application: typeof import('./application')) => ({
	verifyFile: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.verifyFile(req.user as Actor, req.body || {}));
	},
	uploadChunk: async (req: Request, res: Response): Promise<void> => {
		respond(
			res,
			await application.uploadChunk(req.user as Actor, {
				...req.body,
				chunk: req.file?.buffer,
				mime: req.file?.mimetype
			})
		);
	},
	mergeFile: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.mergeFile(req.user as Actor, req.body || {}));
	}
});
