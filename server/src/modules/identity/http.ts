import type { Request, Response } from 'express';
import { respond } from '../../infrastructure/http-outcome';
import type { Actor } from '../../shared/actor';
export const createHttpHandlers = (
	application: ReturnType<typeof import('./application').createIdentityApplication>
) => ({
	login: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.login(req.body || {}));
	},
	logout: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.logout(req.user as Actor, req.headers?.authorization));
	},
	register: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.register(req.body || {}));
	},
	forgetPassword: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.forgetPassword(req.user as Actor, req.body || {}));
	},
	updateInfo: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.updateInfo(req.user as Actor, req.body || {}));
	}
});
