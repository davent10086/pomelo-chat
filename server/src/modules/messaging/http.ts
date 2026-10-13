import type { Request, Response } from 'express';
import { respond } from '../../infrastructure/http-outcome';
import type { Actor } from '../../shared/actor';
export const createHttpHandlers = (
	application: typeof import('./application') & typeof import('./search-application')
) => ({
	getChatList: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.getChatList(req.user as Actor));
	},
	getHistory: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.getHistory(req.user as Actor, req.query));
	},
	markRead: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.markRead(req.user as Actor, req.body || {}));
	},
	searchMessages: async (req: Request, res: Response): Promise<void> => {
		respond(
			res,
			await application.searchMessages(
				req.user as Actor,
				{ ...req.query, ...req.body, ...req.params },
				req.headers?.authorization
			)
		);
	},
	getMessageContext: async (req: Request, res: Response): Promise<void> => {
		respond(
			res,
			await application.getMessageContext(
				req.user as Actor,
				{ ...req.query, ...req.body, ...req.params },
				req.headers?.authorization
			)
		);
	},
	resolveMessages: async (req: Request, res: Response): Promise<void> => {
		respond(
			res,
			await application.resolveMessages(
				req.user as Actor,
				{ ...req.query, ...req.body, ...req.params },
				req.headers?.authorization
			)
		);
	}
});
