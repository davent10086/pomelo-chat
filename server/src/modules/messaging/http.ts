import type { Request, Response } from 'express';
import { respond } from '../../infrastructure/http-outcome';
import type { Actor } from '../../shared/actor';
import type { ReadReceiptFrame } from './contracts';
export const createHttpHandlers = (
	application: typeof import('./application') & typeof import('./search-application'),
	publishReadReceipt: (frame: ReadReceiptFrame) => Promise<void> = async () => {}
) => ({
	getChatList: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.getChatList(req.user as Actor));
	},
	getHistory: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.getHistory(req.user as Actor, req.query));
	},
	markRead: async (req: Request, res: Response): Promise<void> => {
		const result = await application.markRead(req.user as Actor, req.body || {});
		if (result.code === 200 && req.body?.type === 'private') {
			const data = result.data as { room: string; roomSeq: number };
			try {
				await publishReadReceipt({
					name: 'read_receipt',
					room: data.room,
					userId: (req.user as Actor).id,
					roomSeq: data.roomSeq
				});
			} catch (error) {
				// The persisted cursor remains authoritative after a fanout outage.
				console.error('[message] read receipt delivery failed:', error);
			}
		}
		respond(res, result);
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
