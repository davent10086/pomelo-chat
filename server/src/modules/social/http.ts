import type { Request, Response } from 'express';
import { respond } from '../../infrastructure/http-outcome';
import type { Actor } from '../../shared/actor';
export const createHttpHandlers = (application: {
	friends: ReturnType<typeof import('./friends').createFriendApplication>;
	groups: ReturnType<typeof import('./groups').createGroupApplication>;
}) => ({
	searchUser: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.friends.searchUser(req.user as Actor, req.query));
	},
	addFriend: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.friends.addFriend(req.user as Actor, req.body || {}));
	},
	getFriendList: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.friends.getFriendList(req.user as Actor));
	},
	getFriendById: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.friends.getFriendById(req.user as Actor, req.query));
	},
	getFriendGroupList: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.friends.getFriendGroupList(req.user as Actor));
	},
	createFriendGroup: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.friends.createFriendGroup(req.user as Actor, req.body || {}));
	},
	updateFriend: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.friends.updateFriend(req.user as Actor, req.body || {}));
	},
	createGroupChat: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.groups.createGroupChat(req.user as Actor, req.body || {}));
	},
	getGroupChatList: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.groups.getGroupChatList(req.user as Actor));
	},
	searchGroupChat: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.groups.searchGroupChat(req.user as Actor, req.query));
	},
	getGroupChatInfo: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.groups.getGroupChatInfo(req.user as Actor, req.query));
	},
	inviteFriendToGroupChat: async (req: Request, res: Response): Promise<void> => {
		respond(
			res,
			await application.groups.inviteFriendToGroupChat(req.user as Actor, req.body || {})
		);
	},
	joinGroupChat: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.groups.joinGroupChat(req.user as Actor, req.body || {}));
	},
	getGroupMemberList: async (req: Request, res: Response): Promise<void> => {
		respond(res, await application.groups.getGroupMemberList(req.user as Actor, req.query));
	}
});
