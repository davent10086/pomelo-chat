import type { Request, Response } from 'express';
import { respond } from '../../infrastructure/http-outcome';
import type { Actor } from '../../shared/actor';
export const createHttpHandlers = (
	application: typeof import('./actions') & typeof import('./agent-application')
) => ({
	prepareMessage: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.prepareMessage(req.user as Actor, req.body || {}));
	},
	confirmAction: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.confirmAction(req.user as Actor, req.body || {}));
	},
	getActionStatus: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.getActionStatus(req.user as Actor, req.params));
	},
	cancelAction: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.cancelAction(req.user as Actor, req.body || {}));
	},
	listTasks: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.listTasks(req.user as Actor));
	},
	updateTask: async (req: Request, res: Response): Promise<void> => {
		respond(
			res,
			await application.updateTask(req.user as Actor, { ...req.body, id: req.params.id })
		);
	},
	agentChat: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.agentChat(req.user as Actor, req.body || {}));
	},
	listAgentTools: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.listAgentTools(req.user as Actor));
	},
	callAgentTool: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.callAgentTool(req.user as Actor, req.body || {}));
	},
	taskCandidates: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.taskCandidates(req.user as Actor, req.body || {}));
	}
});
