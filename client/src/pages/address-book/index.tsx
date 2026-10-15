import { WechatOutlined } from '@ant-design/icons';
import { Tabs, Tooltip, Modal, Form, Input, Empty, type TabsProps } from 'antd';
import { forwardRef, useImperativeHandle, useState } from 'react';
import { TabType, type IAddressBookProps } from './type';
import { useAddressBook } from './useAddressBook';
import { FriendTree } from './FriendTree';
import { FriendDetails } from './FriendDetails';
import { GroupDetails } from './GroupDetails';
import styles from './index.module.less';
import ImageLoad from '@/components/ImageLoad';
import SearchContainer from '@/components/SearchContainer';
import AiAssistantCard from '@/components/AiAssistantCard';
import { userStorage } from '@/utils/storage';

const AddressBook = forwardRef(({ handleChooseChat }: IAddressBookProps, ref) => {
	const user = userStorage.getItem();
	const data = useAddressBook(user);
	const [searchQuery, setSearchQuery] = useState('');
	const [curTab, setCurTab] = useState(TabType.FRIEND);
	const [openCreateGroupModal, setOpenCreateGroupModal] = useState(false);
	const [newGroupName, setNewGroupName] = useState('');
	const { curFriendInfo, curGroupChatInfo, refreshFriendList, refreshGroupChatList } = data;
	useImperativeHandle(ref, () => ({ refreshFriendList, refreshGroupChatList }), [
		refreshFriendList,
		refreshGroupChatList
	]);
	const titleLabel = (tab: TabType) => (
		<Tooltip
			placement="bottomLeft"
			arrow={false}
			overlayClassName="addContent"
			trigger="contextMenu"
			title={
				<ul>
					<li
						onClick={() =>
							void (tab === TabType.FRIEND ? refreshFriendList() : refreshGroupChatList())
						}
					>
						刷新列表
					</li>
					{tab === TabType.FRIEND && (
						<li
							onClick={() => {
								setNewGroupName('');
								setOpenCreateGroupModal(true);
							}}
						>
							新建分组
						</li>
					)}
				</ul>
			}
		>
			{tab === TabType.FRIEND ? '好友' : '群聊'}
		</Tooltip>
	);
	const keyword = searchQuery.trim().toLocaleLowerCase();
	const groups = data.groupChatList.filter(
		group => !keyword || group.name.toLocaleLowerCase().includes(keyword)
	);
	const items: TabsProps['items'] = [
		{
			key: TabType.FRIEND,
			label: titleLabel(TabType.FRIEND),
			children: (
				<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
					<AiAssistantCard userId={user.id} onChooseChat={handleChooseChat} />
					<FriendTree
						friendList={data.friendList}
						query={searchQuery}
						onSelect={id => void data.selectFriend(id)}
					/>
				</div>
			)
		},
		{
			key: TabType.GROUP_CHAT,
			label: titleLabel(TabType.GROUP_CHAT),
			children: groups.length ? (
				<div className={styles.groupChatList}>
					{groups.map(group => (
						<div
							key={group.id}
							onClick={() => void data.selectGroup(group)}
							className={`${styles.groupChat} ${curGroupChatInfo?.id === group.id ? styles.curGroupChatInfo : ''}`}
						>
							<ImageLoad src={group.avatar} />
							<span>{group.name}</span>
						</div>
					))}
				</div>
			) : (
				<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
			)
		}
	];
	return (
		<div className={styles.addressBook}>
			<div className={styles.leftContainer}>
				<div className={styles.search}>
					<SearchContainer
						query={searchQuery}
						onSearchChange={setSearchQuery}
						placeholder="搜索联系人或群聊"
					/>
				</div>
				<div className={styles.list}>
					<div className={styles.addressBookTabs}>
						<Tabs
							centered
							activeKey={curTab}
							items={items}
							onChange={key => setCurTab(key as TabType)}
						/>
					</div>
				</div>
			</div>
			<div className={styles.rightContainer}>
				{curTab === TabType.FRIEND &&
					(curFriendInfo ? (
						<FriendDetails
							key={curFriendInfo.friend_id}
							curFriendInfo={curFriendInfo}
							groupList={data.groupList}
							onSave={data.saveFriend}
							handleChooseChat={handleChooseChat}
						/>
					) : (
						<WechatOutlined />
					))}
				{curTab === TabType.GROUP_CHAT &&
					(curGroupChatInfo ? (
						<GroupDetails
							key={curGroupChatInfo.id}
							curGroupChatInfo={curGroupChatInfo}
							handleChooseChat={handleChooseChat}
						/>
					) : (
						<WechatOutlined />
					))}
			</div>
			{openCreateGroupModal && (
				<Modal
					title="新建分组"
					open
					onCancel={() => setOpenCreateGroupModal(false)}
					onOk={async () => {
						if (await data.createGroup(newGroupName)) setOpenCreateGroupModal(false);
					}}
					cancelText="取消"
					okText="确定"
					width="4rem"
				>
					<Form name="createGroupForm">
						<Form.Item name="groupName">
							<Input
								placeholder="请输入分组名称"
								value={newGroupName}
								onChange={event => setNewGroupName(event.target.value)}
							/>
						</Form.Item>
					</Form>
				</Modal>
			)}
		</div>
	);
});
AddressBook.displayName = 'AddressBook';
export default AddressBook;
