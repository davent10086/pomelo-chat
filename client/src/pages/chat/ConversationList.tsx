import { useState } from 'react';
import { Tooltip } from 'antd';
import type { IMessageListItem } from '@/components/ChatTool/type';
import ImageLoad from '@/components/ImageLoad';
import SearchContainer from '@/components/SearchContainer';
import { formatChatListTime } from '@/utils/time';
import styles from './index.module.less';
import { AI_USERNAME } from '@/hooks/useAiAssistant';
export default function ConversationList({
	chatList,
	curChatInfo,
	chooseRoom
}: {
	chatList: IMessageListItem[];
	curChatInfo?: IMessageListItem;
	chooseRoom: (item: IMessageListItem) => void;
}) {
	const [query, setQuery] = useState('');
	const keyword = query.trim().toLocaleLowerCase();
	const filteredChats = chatList.filter(item =>
		[item.name, item.receiver_username].some(value => value?.toLocaleLowerCase().includes(keyword))
	);
	const isAssistantListItem = (item: IMessageListItem) =>
		item.receiver_username === AI_USERNAME || item.room.startsWith('ai_');
	const isGroupChat = (item: IMessageListItem) => !item.receiver_username;
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
						<button
							type="button"
							className={`${styles.chat_item} ${isAssistantListItem(item) ? styles.assistant_item : ''} ${curChatInfo?.room === item.room ? styles.selectedChat : ''}`}
							aria-pressed={curChatInfo?.room === item.room}
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
									{isGroupChat(item) && (
										<span
											className={`icon iconfont icon-jinqunliaoliao ${styles.group_icon}`}
										></span>
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
					))
				)}
			</div>
		</div>
	);
}
