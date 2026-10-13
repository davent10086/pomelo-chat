import type { Request, Response } from 'express';
import { respond } from '../../infrastructure/http-outcome';
import type { Actor } from '../../shared/actor';
export const createHttpHandlers = (
	application: ReturnType<typeof import('./application').createRtcApplication>
) => ({
	createJoinToken: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.createJoinToken(req.user as Actor, req.body || {}));
	},
	invite: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.invite(req.user as Actor, req.body || {}));
	},
	acceptCall: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.acceptCall(req.user as Actor, req.body || {}));
	},
	endCall: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.endCall(req.user as Actor, req.body || {}));
	}
});
