import { useCallback, useEffect, useRef, useState } from 'react';
import {
	getFriendList,
	getFriendGroup,
	getFriendInfoById,
	getGroupChatList,
	getGroupChatInfo,
	updateFriendInfo,
	createFriendGroup
} from './api';
import type { IFriendInfo, IFriendGroupListItem, IFriendInfoForm, IGroupChatItem } from './type';
import type { IFriendGroupItem, IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import type { IUserInfo } from '@/utils/storage';
import useShowMessage from '@/hooks/useShowMessage';
import { HttpStatus } from '@/utils/constant';

/** List refreshes and detail selection have independent cancellation scopes. */
export function useAddressBook(user: IUserInfo) {
	const showMessage = useShowMessage();
	const [friendList, setFriendList] = useState<IFriendGroupItem[]>([]);
	const [groupList, setGroupList] = useState<IFriendGroupListItem[]>([]);
	const [groupChatList, setGroupChatList] = useState<IGroupChatItem[]>([]);
	const [curFriendInfo, setCurFriendInfo] = useState<IFriendInfo>();
	const [curGroupChatInfo, setCurGroupChatInfo] = useState<IGroupChatInfo>();
	const active = useRef(false);
	const requests = useRef(new Map<string, AbortController>());
	const run = useCallback(
		async <T>(
			key: string,
			operation: (signal: AbortSignal) => Promise<{ code: number; data: T }>,
			publish: (data: T) => void,
			error: string
		) => {
			if (!active.current) return false;
			requests.current.get(key)?.abort();
			const controller = new AbortController();
			requests.current.set(key, controller);
			try {
				const response = await operation(controller.signal);
				if (
					!active.current ||
					controller.signal.aborted ||
					requests.current.get(key) !== controller
				)
					return false;
				if (response.code !== HttpStatus.SUCCESS) throw new Error('Request failed');
				publish(response.data);
				return true;
			} catch {
				if (
					active.current &&
					!controller.signal.aborted &&
					requests.current.get(key) === controller
				)
					showMessage('error', error);
				return false;
			} finally {
				if (requests.current.get(key) === controller) requests.current.delete(key);
			}
		},
		[showMessage]
	);
	const refreshFriendList = useCallback(
		() => run('friends', getFriendList, setFriendList, '获取好友列表失败'),
		[run]
	);
	const refreshFriendGroups = useCallback(
		() => run('friend-groups', getFriendGroup, setGroupList, '获取好友分组列表失败'),
		[run]
	);
	const refreshGroupChatList = useCallback(
		() => run('groups', getGroupChatList, setGroupChatList, '获取群聊列表失败'),
		[run]
	);
	useEffect(() => {
		const currentRequests = requests.current;
		active.current = true;
		setFriendList([]);
		setGroupList([]);
		setGroupChatList([]);
		setCurFriendInfo(undefined);
		setCurGroupChatInfo(undefined);
		void Promise.all([refreshFriendList(), refreshFriendGroups(), refreshGroupChatList()]);
		return () => {
			active.current = false;
			for (const controller of currentRequests.values()) controller.abort();
			currentRequests.clear();
		};
	}, [user.id, refreshFriendList, refreshFriendGroups, refreshGroupChatList]);
	const selectFriend = (id: number) =>
		run(
			'friend-detail',
			signal => getFriendInfoById(id, signal),
			setCurFriendInfo,
			'获取好友信息失败'
		);
	const selectGroup = (group: IGroupChatItem) =>
		run(
			'group-detail',
			signal => getGroupChatInfo(group.id, signal),
			setCurGroupChatInfo,
			'获取群聊信息失败'
		);
	const saveFriend = async (values: IFriendInfoForm) => {
		if (!curFriendInfo) return false;
		const success = await run(
			'save-friend',
			signal =>
				updateFriendInfo(
					{
						friend_id: curFriendInfo.friend_id,
						remark: values.remark || curFriendInfo.username,
						group_id: values.group
					},
					signal
				),
			() => undefined,
			'修改失败，请重试'
		);
		if (success) {
			showMessage('success', '修改成功');
			void refreshFriendList();
		}
		return success;
	};
	const createGroup = async (name: string) => {
		if (!name.trim()) {
			showMessage('error', '请输入分组名称');
			return false;
		}
		const success = await run(
			'create-friend-group',
			signal =>
				createFriendGroup({ user_id: user.id, username: user.username, name: name.trim() }, signal),
			() => undefined,
			'新建失败，请重试'
		);
		if (success) {
			showMessage('success', '新建成功');
			await Promise.all([refreshFriendList(), refreshFriendGroups()]);
		}
		return success;
	};
	return {
		friendList,
		groupList,
		groupChatList,
		curFriendInfo,
		curGroupChatInfo,
		refreshFriendList,
		refreshGroupChatList,
		selectFriend,
		selectGroup,
		saveFriend,
		createGroup
	};
}
