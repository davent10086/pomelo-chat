import { useEffect, useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import { readConversationPreferences, writeConversationPreferences, subscribeConversationPreferences } from '@/utils/conversation-preferences';
import { TeamOutlined, MoreOutlined } from '@ant-design/icons';
import type { IMessageListItem } from '@/components/ChatTool/type';
import ImageLoad from '@/components/ImageLoad';
import SearchContainer from '@/components/SearchContainer';
import { formatChatListTime } from '@/utils/time';
import styles from './index.module.less';
import { AI_USERNAME } from '@/hooks/useAiAssistant';
export default function ConversationList({
	chatList,
	curChatInfo,
	chooseRoom,
	onMarkRead
}: {
	chatList: IMessageListItem[];
	curChatInfo?: IMessageListItem;
	chooseRoom: (item: IMessageListItem) => void;
	onMarkRead: (item: IMessageListItem) => void;
}) {
	const [query, setQuery] = useState('');
	const [, updatePreferences] = useState(0);
	useEffect(() => subscribeConversationPreferences(() => updatePreferences(value => value + 1)), []);
	const keyword = query.trim().toLocaleLowerCase();
	const filteredChats = chatList.filter(item =>
		[item.name, item.receiver_username].some(value => value?.toLocaleLowerCase().includes(keyword))
	).sort((a, b) => Number(!!readConversationPreferences(b.room).pinned) - Number(!!readConversationPreferences(a.room).pinned));
	const isAssistantListItem = (item: IMessageListItem) =>
		item.receiver_username === AI_USERNAME || item.room.startsWith('ai_');
	const isGroupChat = (item: IMessageListItem) => !item.receiver_username;
	const menuItems = (item: IMessageListItem) => [
		{ key: 'read', label: '标为已读', disabled: isAssistantListItem(item) || !item.unreadCount, onClick: () => onMarkRead(item) },
		{ key: 'pin', label: readConversationPreferences(item.room).pinned ? '取消置顶' : '置顶会话', onClick: () => writeConversationPreferences(item.room, { pinned: !readConversationPreferences(item.room).pinned }) },
		{ key: 'mute', label: readConversationPreferences(item.room).muted ? '取消免打扰' : '消息免打扰', onClick: () => writeConversationPreferences(item.room, { muted: !readConversationPreferences(item.room).muted }) },
		{ key: 'restore', label: '恢复本地隐藏的消息', disabled: !readConversationPreferences(item.room).hiddenMessageIds?.length, onClick: () => writeConversationPreferences(item.room, { hiddenMessageIds: [] }) }
	];

	return (
		<div className={styles.leftContainer}>
			<div className={styles.search}>
				<SearchContainer query={query} onSearchChange={setQuery} />
			</div>
			<div className={styles.list}>
				{filteredChats.length === 0 ? (
					<div className={styles.chat_none}>
						{keyword ? '没有匹配的会话，试试姓名或账号' : '暂无会话'}
					</div>
				) : (
					filteredChats.map(item => (
						<Dropdown key={item.room} trigger={['contextMenu']} menu={{ items: menuItems(item) }}>
						<div className={styles.conversationRow}>
						<button
							type="button"
							className={`${styles.chat_item} ${isAssistantListItem(item) ? styles.assistant_item : ''} ${curChatInfo?.room === item.room ? styles.selectedChat : ''}`}
							aria-pressed={curChatInfo?.room === item.room}
							title="右键打开会话管理菜单"
							key={item.room}
							id={`chatList_${item.room}`}
							onClick={() => chooseRoom(item)}
						>
							<div className={styles.chat_avatar}>
								<ImageLoad src={item.avatar} />
							</div>
							<div className={styles.chat_info}>
								<div className={styles.chat_name}>
									<span>{item.name}</span>
									{readConversationPreferences(item.room).pinned && <small aria-label="已置顶"> · 置顶</small>}
									{readConversationPreferences(item.room).muted && <small aria-label="免打扰"> · 免打扰</small>}
									{isGroupChat(item) && (
										<TeamOutlined className={styles.group_icon} />
									)}
								</div>
								<div className={styles.chat_message}>
									{item.type === 'text'
										? item.lastMessage
										: item.type === 'image'
											? '[图片]'
											: item.type === 'video'
												? '[视频]'
												: item.type === 'file'
													? '[文件]'
													: null}
								</div>
							</div>
							<div className={styles.chat_info_time}>
								<Tooltip
									placement="bottomLeft"
									title={formatChatListTime(item.updated_at)}
									arrow={false}
								>
									<div className={styles.chat_time}>{formatChatListTime(item.updated_at)}</div>
								</Tooltip>
								{item.unreadCount !== 0 && (
									<Tooltip
										placement="bottomLeft"
										title={`未读消息： ${item.unreadCount}`}
										arrow={false}
									>
										<div className={styles.chat_unread}>
											<span>{item.unreadCount}</span>
										</div>
									</Tooltip>
								)}
							</div>
						</button>
						<Dropdown trigger={['click']} menu={{ items: menuItems(item) }}>
							<button type="button" className={styles.conversationActions} aria-label={`管理会话 ${item.name}`} title="会话管理">
								<MoreOutlined />
							</button>
						</Dropdown>
						</div>
						</Dropdown>
					))
				)}
			</div>
		</div>
	);
}
