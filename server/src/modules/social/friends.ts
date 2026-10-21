export interface SearchUserInput {
	username?: unknown;
	afterId?: unknown;
	limit?: unknown;
}
export interface AddFriendInput {
	id?: unknown;
	username?: unknown;
}
export interface GetFriendByIdInput {
	id?: unknown;
}
export interface CreateFriendGroupInput {
	name?: unknown;
}
export interface UpdateFriendInput {
	friend_id?: unknown;
	remark?: unknown;
	group_id?: unknown;
}
import * as repository from './repository';
import * as readModel from '../../read-models/social';
import type { SocialEffects } from './contracts';
import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
import { randomUUID } from 'crypto';
import { CommonStatus, FriendStatus } from '../../shared/status';
import { withTransaction } from '../../infrastructure/database-query';
import { parseSearchPage, escapeSearchTerm } from '../../shared/search-page';
import { positiveId } from '../../shared/validation';
import { onlineUsernames } from './presence';
export const createFriendApplication = (dependencies: SocialEffects) => {
	const { notifyUser: NotificationUser, isOnline } = dependencies;
	interface FriendRow {
		id: number;
		user_id: number | string;
		username: string;
		avatar?: string | null;
		remark?: string | null;
		online_status?: string;
		group_id: number | string;
		room: string;
	}
	interface FriendGroupIdRow {
		id: number;
		user_id?: number | string;
	}
	interface FriendGroupRow extends FriendGroupIdRow {
		name: string;
	}
	interface FriendGroupRecord extends FriendGroupRow {
		user_id: number | string;
		username: string;
	}
	interface FriendDetailRow {
		friend_id: number;
		friend_user_id: number;
		online_status: string;
		remark: string | null;
		group_id: number;
		group_name: string;
		room: string;
		unread_msg_count: number;
		username: string;
		avatar: string | null;
		name: string | null;
		signature: string | null;
	}
	interface UserSearchRow {
		id: number;
		name: string | null;
		username: string;
		avatar: string | null;
	}
	interface FriendSearchItem extends UserSearchRow {
		status: boolean;
	}
	interface FriendGroupListItem {
		name: string;
		online_counts: number;
		friend: FriendRow[];
	}
	interface WriteResult {
		affectedRows: number;
		insertId?: number;
	}
	const searchUser = async (actor: Actor, parameters: SearchUserInput): Promise<Outcome> => {
		// 获取当前登录的用户信息、模糊查询关键字
		const sender = actor;
		const username = parameters.username;
		const page = parseSearchPage(parameters);
		if (!page || typeof username !== 'string' || !username.trim() || username.length > 255) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const rows = await readModel.searchUsersWithFriendStatus<
				Array<UserSearchRow & { status: number }>
			>([sender.id, `%${escapeSearchTerm(username.trim())}%`, sender.id, page.afterId, page.limit]);
			const searchList: FriendSearchItem[] = rows.map(row => ({
				...row,
				status: Boolean(row.status)
			}));
			return success(searchList);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[friend] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const addFriend = async (actor: Actor, parameters: AddFriendInput): Promise<Outcome> => {
		const sender = actor;
		const { id, username } = parameters || {};
		const targetId = positiveId(id);
		if (
			!sender ||
			targetId === null ||
			targetId <= 0 ||
			typeof username !== 'string' ||
			!username.trim() ||
			targetId === Number(sender.id)
		) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const uuid = randomUUID();
			const outcome = await withTransaction(async query => {
				const targetRows = await readModel.lockInviteeIdentity<
					Array<{ id: number; username: string; avatar: string | null; name: string | null }>
				>([targetId, username.trim()], query);
				if (!targetRows.length) return 'invalid';
				const groups = await repository.lockContactGroups<FriendGroupIdRow[]>(
					[sender.id, targetId],
					query
				);
				const senderGroup = groups.find(group => String(group.user_id) === String(sender.id));
				const targetGroup = groups.find(group => String(group.user_id) === String(targetId));
				if (!senderGroup || !targetGroup) throw new Error('default friend group missing');
				const existing = await repository.lockExistingFriendship<Array<{ id: number }>>(
					[sender.id, targetId, targetId, sender.id],
					query
				);
				if (existing.length) return 'exists';
				const target = targetRows[0];
				await repository.insertFriend(
					{
						owner_id: sender.id,
						user_id: target.id,
						username: target.username,
						avatar: target.avatar,
						online_status: isOnline(target.username) ? 'online' : 'offline',
						remark: target.username,
						group_id: senderGroup.id,
						room: uuid
					},
					query
				);
				await repository.insertReciprocalFriend(
					{
						owner_id: targetId,
						user_id: sender.id,
						username: sender.username,
						avatar: sender.avatar,
						online_status: isOnline(sender.username) ? 'online' : 'offline',
						remark: sender.name,
						group_id: targetGroup.id,
						room: uuid
					},
					query
				);
				return 'created';
			});
			if (outcome === 'invalid') return failure(CommonStatus.NOT_FOUND);
			if (outcome === 'exists') return failure(FriendStatus.FRIEND_ALREADY_ADDED);
			void NotificationUser({ receiver_username: username.trim(), name: 'friendList' }).catch(
				error => console.error('[friend] notification failed:', error)
			);
			void NotificationUser({ receiver_username: sender.username, name: 'friendList' }).catch(
				error => console.error('[friend] notification failed:', error)
			);
			return success();
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[friend] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const getFriendList = async (actor: Actor): Promise<Outcome> => {
		try {
			const sender = actor;

			// 获取当前用户的所有分组
			const results = await repository.listFriendGroupNames<FriendGroupRow[]>([sender.id]);
			const friends = results.length
				? await repository.listFriendsByOwner<FriendRow[]>([sender.id])
				: [];
			const byGroup = new Map<string, FriendRow[]>();
			const online = await onlineUsernames(friends.map(friend => friend.username));
			for (const friend of friends) {
				friend.online_status = online.has(friend.username) ? 'online' : 'offline';
				const key = String(friend.group_id);
				const bucket = byGroup.get(key) || [];
				bucket.push(friend);
				byGroup.set(key, bucket);
			}
			const friendList: FriendGroupListItem[] = results.map(group => {
				const friend = byGroup.get(String(group.id)) || [];
				return {
					name: group.name,
					friend,
					online_counts: friend.filter(item => item.online_status === 'online').length
				};
			});
			return success(friendList);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[friend] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const getFriendById = async (actor: Actor, parameters: GetFriendByIdInput): Promise<Outcome> => {
		const id = positiveId(parameters?.id);
		if (!id) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results = await readModel.findFriendProfile<FriendDetailRow[]>([id, actor.id]);
			if (results.length !== 0) {
				results[0].online_status = (await onlineUsernames([results[0].username])).has(results[0].username) ? 'online' : 'offline';
				return success(results[0]);
			} else {
				return failure(CommonStatus.NOT_FOUND);
			}
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[friend] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const getFriendGroupList = async (actor: Actor): Promise<Outcome> => {
		const user_id = actor.id;
		if (!user_id) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results = await repository.listFriendGroups<FriendGroupRecord[]>([user_id]);
			return success(results);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[friend] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const createFriendGroup = async (
		actor: Actor,
		parameters: CreateFriendGroupInput
	): Promise<Outcome> => {
		const name = parameters.name;
		if (typeof name !== 'string' || !name.trim() || name.length > 50) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results = await repository.insertFriendGroup<WriteResult>({
				user_id: actor.id,
				username: actor.username,
				name: name.trim()
			});
			if (results.affectedRows === 1) {
				return success();
			} else {
				return failure(CommonStatus.UPDATE_ERR);
			}
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[friend] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const updateFriend = async (actor: Actor, parameters: UpdateFriendInput): Promise<Outcome> => {
		const { friend_id, remark, group_id } = parameters || {};
		if (
			(typeof friend_id !== 'number' && typeof friend_id !== 'string') ||
			!Number.isSafeInteger(Number(friend_id)) ||
			Number(friend_id) <= 0 ||
			(typeof group_id !== 'number' && typeof group_id !== 'string') ||
			!Number.isSafeInteger(Number(group_id)) ||
			Number(group_id) <= 0 ||
			typeof remark !== 'string' ||
			remark.length > 50
		) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results = await repository.updateOwnedFriend<WriteResult>([
				group_id,
				actor.id,
				actor.id,
				remark,
				group_id,
				friend_id
			]);
			if (results.affectedRows === 1) {
				return success();
			} else {
				return failure(CommonStatus.NOT_FOUND);
			}
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[friend] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	return {
		searchUser,
		addFriend,
		getFriendList,
		getFriendById,
		getFriendGroupList,
		createFriendGroup,
		updateFriend
	};
};
