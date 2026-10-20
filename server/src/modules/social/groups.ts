export interface CreateGroupChatInput {
	name?: unknown;
	members?: unknown;
	avatar?: unknown;
	announcement?: unknown;
}
export interface SearchGroupChatInput {
	name?: unknown;
	afterId?: unknown;
	limit?: unknown;
}
export interface GetGroupChatInfoInput {
	group_id?: unknown;
}
export interface InviteFriendToGroupChatInput {
	groupId?: unknown;
	invitationList?: unknown;
}
export interface JoinGroupChatInput {
	group_id?: unknown;
}
export interface GetGroupMemberListInput {
	group_id?: unknown;
	room?: unknown;
}
import * as repository from './repository';
import * as readModel from '../../read-models/social';
import type { SocialEffects } from './contracts';
import type { Actor } from '../../shared/actor';
import { success, failure, type Outcome } from '../../shared/outcome';
import { randomUUID } from 'crypto';
import { CommonStatus, GroupStatus } from '../../shared/status';
import { withTransaction } from '../../infrastructure/database-query';
import { parseSearchPage, escapeSearchTerm } from '../../shared/search-page';
import { assertOwnedAvatar } from '../files/public';
import { positiveId } from '../../shared/validation';
export const createGroupApplication = (dependencies: SocialEffects) => {
	const { notifyUser: NotificationUser, initializeGroupMessage: persistMessage } = dependencies;
	interface GroupMemberRow {
		user_id: number;
		avatar: string | null;
		username: string;
		name: string | null;
		nickname: string | null;
		created_at: Date | string;
		lastMessageTime: Date | string | null;
	}
	interface ExistsRow {
		'1': number;
	}
	interface WriteResult {
		affectedRows: number;
		insertId?: number;
	}
	interface GroupChatRow {
		id: number;
		name: string;
		avatar: string | null;
		announcement: string | null;
		room: string;
		creator_id: number;
		created_at: Date | string;
	}
	interface GroupSearchItem {
		name: string;
		avatar: string | null;
		number: number;
		status: boolean;
		group_id: number;
	}
	interface GroupInfoRow extends GroupChatRow {
		creator_username: string;
	}
	interface GroupInfo extends GroupInfoRow {
		members: GroupMemberRow[];
	}
	interface InvitationInput {
		user_id: number | string;
		username: string;
	}
	interface InvitationInsert {
		group_id: number | string;
		user_id: number | string;
		nickname: string;
	}
	interface GroupIdRow {
		id: number;
	}
	interface GroupRoomRow {
		name?: string;
		room: string;
	}
	interface UserIdentityRow {
		id: number;
		username: string;
	}
	const isInvitationInput = (value: unknown): value is InvitationInput =>
		typeof value === 'object' &&
		value !== null &&
		(typeof (value as { user_id?: unknown }).user_id === 'number' ||
			typeof (value as { user_id?: unknown }).user_id === 'string') &&
		typeof (value as { username?: unknown }).username === 'string';
	const getGroupMembers = async (
		group_id: number | string,
		room: string
	): Promise<GroupMemberRow[]> => {
		try {
			const results = await readModel.listGroupMembersWithActivity<GroupMemberRow[]>([
				group_id,
				room
			]);
			return results;
		} catch {
			throw new Error('查询失败');
		}
	};
	const canAccessGroup = async (
		userId: number | string,
		groupId: number | string
	): Promise<boolean> => {
		const rows = await repository.findGroupMembership<ExistsRow[]>([groupId, userId]);
		return rows.length > 0;
	};
	const validateInvitees = async (
		ownerId: number | string,
		values: unknown[]
	): Promise<InvitationInput[] | null> => {
		const requested = values.filter(isInvitationInput);
		if (requested.length !== values.length || !requested.length) return null;
		const ids = [...new Set(requested.map(item => Number(item.user_id)))];
		if (ids.length !== requested.length) return null;
		if (ids.some(id => !Number.isInteger(id) || id <= 0)) return null;
		const users = await readModel.findInviteeIdentities<UserIdentityRow[]>([ids]);
		if (users.length !== ids.length) return null;
		const byId = new Map(users.map(user => [user.id, user]));
		for (const item of requested) {
			const user = byId.get(Number(item.user_id));
			if (!user || user.username !== item.username) return null;
		}
		const nonSelf = ids.filter(id => String(id) !== String(ownerId));
		if (nonSelf.length) {
			const contacts = await repository.findInviteeContacts<Array<{ user_id: number }>>([
				ownerId,
				nonSelf
			]);
			if (contacts.length !== nonSelf.length) return null;
		}
		return requested.map(item => ({ user_id: Number(item.user_id), username: item.username }));
	};
	const createGroupChat = async (
		actor: Actor,
		parameters: CreateGroupChatInput
	): Promise<Outcome> => {
		const groupInfo = parameters || {};
		if (
			typeof groupInfo.name !== 'string' ||
			!groupInfo.name.trim() ||
			groupInfo.name.length > 50 ||
			(groupInfo.announcement !== null && groupInfo.announcement !== undefined && (typeof groupInfo.announcement !== 'string' || groupInfo.announcement.length > 5000)) ||
			!Array.isArray(groupInfo.members)
		) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			await assertOwnedAvatar(actor.id, groupInfo.avatar);
			const invited = await validateInvitees(actor.id, groupInfo.members);
			if (!invited) return failure(CommonStatus.PARAM_ERR);
			const members = [
				...invited.filter(member => String(member.user_id) !== String(actor.id)),
				{ user_id: actor.id, username: actor.username }
			];
			await withTransaction(async query => {
				const uuid = randomUUID();
				const group = await repository.insertGroup<WriteResult>(
					{
						name: (groupInfo.name as string).trim(),
						creator_id: actor.id,
						avatar: groupInfo.avatar,
						announcement: groupInfo.announcement,
						room: uuid
					},
					query
				);
				if (!group.insertId) throw new Error('group creation failed');
				await persistMessage(query, {
					sender_id: actor.id,
					receiver_id: group.insertId,
					type: 'group',
					media_type: 'text',
					file_size: 0,
					status: 0,
					content: '大家可以一起聊天了!',
					room: uuid
				});
				await repository.insertInitialGroupMembers(
					[members.map(member => [group.insertId, member.user_id, member.username])],
					query
				);
			});
			for (const member of members)
				void NotificationUser({ receiver_username: member.username, name: 'groupChatList' }).catch(
					error => console.error('[group] notification failed:', error)
				);
			return success();
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[group] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const getGroupChatList = async (actor: Actor): Promise<Outcome> => {
		const id = actor.id;
		if (!id) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const results = await repository.listJoinedGroupRecords<GroupChatRow[]>([id]);
			return success(results);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[group] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const searchGroupChat = async (
		actor: Actor,
		parameters: SearchGroupChatInput
	): Promise<Outcome> => {
		const name = parameters.name;
		const page = parseSearchPage(parameters);
		if (!page || typeof name !== 'string' || !name.trim() || name.length > 255) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			const rows = await repository.searchGroupDirectory<
				Array<Omit<GroupSearchItem, 'status'> & { status: number }>
			>([actor.id, `%${escapeSearchTerm(name.trim())}%`, page.afterId, page.limit]);
			return success(
				rows.map(row => ({ ...row, number: Number(row.number), status: Boolean(row.status) }))
			);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[group] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const getGroupChatInfo = async (
		actor: Actor,
		parameters: GetGroupChatInfoInput
	): Promise<Outcome> => {
		const group_id = positiveId(parameters.group_id);
		if (!group_id) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			if (!(await canAccessGroup(actor.id, group_id))) {
				return failure(CommonStatus.UNAUTHORIZED);
			}

			const results_group = await readModel.findGroupWithCreator<GroupInfoRow[]>([group_id]);
			if (!results_group.length) {
				return failure(CommonStatus.NOT_FOUND);
			}
			const info: GroupInfo = {
				id: results_group[0].id,
				name: results_group[0].name,
				creator_id: results_group[0].creator_id,
				creator_username: results_group[0].creator_username,
				avatar: results_group[0].avatar,
				announcement: results_group[0].announcement,
				room: results_group[0].room,
				created_at: results_group[0].created_at,
				members: []
			};
			const results_members = await getGroupMembers(group_id, info.room);
			for (const member of results_members) {
				info.members.push({ ...member });
			}
			return success(info);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[group] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const inviteFriendToGroupChat = async (
		actor: Actor,
		parameters: InviteFriendToGroupChatInput
	): Promise<Outcome> => {
		const { groupId, invitationList } = parameters || {};
		if (!(positiveId(groupId) && Array.isArray(invitationList) && invitationList.length)) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			if (!(await canAccessGroup(actor.id, groupId as number | string))) {
				return failure(CommonStatus.UNAUTHORIZED);
			}
			const invitations = await validateInvitees(actor.id, invitationList);
			if (!invitations) return failure(CommonStatus.PARAM_ERR);
			const userIdArr = invitations.map(item => item.user_id);

			const results_check = await repository.findExistingInvitees<
				Array<{ user_id: number | string }>
			>([groupId, userIdArr.join(',')]);
			// 过滤掉已经存在群里的用户
			const invitationInfoList: InvitationInsert[] = [];
			const hasInvitedUserIdArr = results_check.map(item => item.user_id);
			for (const item of invitations) {
				if (!hasInvitedUserIdArr.includes(item.user_id)) {
					invitationInfoList.push({
						group_id: groupId as number | string,
						user_id: item.user_id,
						nickname: item.username
					});
				}
			}
			if (invitationInfoList.length === 0) {
				return failure(GroupStatus.ALL_EXIT_ERR);
			}
			// 插入新的成员

			await repository.insertInvitedGroupMembers([
				invitationInfoList.map(item => [item.group_id, item.user_id, item.nickname])
			]);
			// 通知对方, 让其群聊列表进行更新
			for (const item of invitationInfoList) {
				void NotificationUser({
					receiver_username: item.nickname,
					name: 'groupChatList'
				}).catch(error => console.error('[group] notification failed:', error));
			}
			return success();
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[group] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const joinGroupChat = async (actor: Actor, parameters: JoinGroupChatInput): Promise<Outcome> => {
		const sender = actor;
		const group_id = parameters.group_id;
		if (!group_id) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			// 检查是否已经加入了该群聊

			const results_check = await repository.findExistingMembership<GroupIdRow[]>([
				group_id,
				sender.id
			]);
			if (results_check.length !== 0) {
				return failure(GroupStatus.EXIT_GROUP_ERR);
			}
			// 插入新的数据
			const info = {
				group_id: group_id,
				user_id: sender.id,
				nickname: sender.name
			};

			await repository.insertGroupMembership(info);

			const results_get = await repository.findGroupRoomAndName<GroupRoomRow[]>([group_id]);
			if (!results_get.length) {
				return failure(CommonStatus.NOT_FOUND);
			}
			const options = {
				room: results_get[0].room,
				name: results_get[0].name,
				group_id: group_id
			};
			// 通知自己，让群聊列表进行更新
			void NotificationUser({
				receiver_username: sender.username,
				name: 'groupChatList'
			}).catch(error => console.error('[group] notification failed:', error));
			return success(options);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[group] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	const getGroupMemberList = async (
		actor: Actor,
		parameters: GetGroupMemberListInput
	): Promise<Outcome> => {
		const group_id = positiveId(parameters.group_id);
		const room = typeof parameters.room === 'string' ? parameters.room : undefined;
		if (!(group_id && room)) {
			return failure(CommonStatus.PARAM_ERR);
		}
		try {
			if (!(await canAccessGroup(actor.id, group_id))) {
				return failure(CommonStatus.UNAUTHORIZED);
			}
			const group = await repository.findGroupRoom<GroupRoomRow[]>([group_id]);
			if (!group.length || group[0].room !== room) {
				return failure(CommonStatus.PARAM_ERR);
			}
			const results = await getGroupMembers(group_id, room);
			return success(results);
		} catch (caught: unknown) {
			const err = caught instanceof Error ? caught : new Error(String(caught));
			console.error('[group] 异常:', err.message);
			return failure(CommonStatus.SERVER_ERR);
		}
	};
	return {
		createGroupChat,
		getGroupChatList,
		searchGroupChat,
		getGroupChatInfo,
		inviteFriendToGroupChat,
		joinGroupChat,
		getGroupMemberList
	};
};
