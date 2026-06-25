import { Tooltip } from 'antd';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { getChatList } from './api';
import styles from './index.module.less';
import { IConnectParams, IChatListProps, IChatRef } from './type';

import { StatusIconList } from '@/assets/icons';
import ChatContainer from '@/components/ChatContainer';
import ChatTool from '@/components/ChatTool';
import { ISendMessage, IMessageListItem } from '@/components/ChatTool/type';
import { IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import ImageLoad from '@/components/ImageLoad';
import { IMessageItem } from '@/components/MessageShow/type';
import SearchContainer from '@/components/SearchContainer';
import { wsBaseURL } from '@/config';
import { AI_USERNAME, getAiAvatar, useAiAssistant } from '@/hooks/useAiAssistant';
import useShowMessage from '@/hooks/useShowMessage';
import { IFriendInfo } from '@/pages/address-book/type';
import { HttpStatus } from '@/utils/constant';
import { safeParse } from '@/utils/safe-parse';
import { tokenStorage, userStorage } from '@/utils/storage';
import { formatChatListTime } from '@/utils/time';
import ReconnectingWebSocket from '@/utils/websocket';

// 自定义类型保护
const isFriendInfo = (chatInfo: IFriendInfo | IGroupChatInfo): chatInfo is IFriendInfo => {
	return (chatInfo as IFriendInfo).friend_id !== undefined;
};

const isGroupChat = (item: IMessageListItem) => !item.receiver_username;

// M4: forwardRef 泛型化，ref 类型为 IChatRef
const Chat = forwardRef<IChatRef, IChatListProps>((props, ref) => {
	const { initSelectedChat } = props;
	// H11: userStorage.getItem() 已返回对象
	const user = userStorage.getItem();
	const showMessage = useShowMessage();
	const [chatList, setChatList] = useState<IMessageListItem[]>([]);
	const [curChatInfo, setCurChatInfo] = useState<IMessageListItem>();
	const socket = useRef<ReconnectingWebSocket | null>(null);
	const [historyMsg, setHistoryMsg] = useState<IMessageItem[]>([]);
	const [newMessage, setNewMessage] = useState<IMessageItem[]>([]);

	// M1: 使用 AI 助手 hook
	const { aiHistory, appendAiHistory, setAiHistory, generateReply } = useAiAssistant(user);

	const AI_AVATAR = getAiAvatar();
	const isAssistantListItem = (item: IMessageListItem | undefined) =>
		!!item && (item.receiver_username === AI_USERNAME || item.room?.startsWith('ai_'));
	const isAssistantInit = (info: IFriendInfo | IGroupChatInfo | null) =>
		!!info && isFriendInfo(info) && (info.username === AI_USERNAME || info.friend_id === -1);

	// 建立聊天 websocket（H3: 携带 token）
	const initSocket = (connectParams: IConnectParams) => {
		if (socket.current !== null) {
			socket.current.close();
			socket.current = null;
		}
		const token = tokenStorage.getItem();
		const ws = new ReconnectingWebSocket(
			`${wsBaseURL}/message/connect_chat?room=${connectParams.room}&id=${connectParams.sender_id}&type=${connectParams.type}&token=${encodeURIComponent(token)}`
		);
		ws.onMessage = e => {
			// H11: safeParse 保护
			const message = safeParse<IMessageItem | IMessageItem[]>(e.data, []);
			if (Array.isArray(message)) {
				setHistoryMsg(message);
				return;
			} else {
				setNewMessage(preMsg => [...preMsg, message]);
			}
		};

		ws.onOpen = () => {
			console.log(`[消息管道] 连接成功 room=${connectParams.room}`);
		};
		ws.onError = () => {
			console.error('[消息管道] 连接出错，将自动重连');
			showMessage('error', '消息连接失败，正在重连...');
		};
		ws.onReconnecting = retryCount => {
			console.log(`[消息管道] 正在重连... 第 ${retryCount} 次`);
		};
		ws.onMaxRetriesReached = () => {
			showMessage('error', '消息连接失败，请刷新页面重试');
		};
		ws.connect();
		socket.current = ws;
	};

	const chooseRoom = (item: IMessageListItem) => {
		setHistoryMsg([]);
		setNewMessage([]);
		setCurChatInfo(item);
		if (isAssistantListItem(item)) {
			setHistoryMsg(aiHistory);
		} else {
			const params: IConnectParams = {
				room: item.room,
				sender_id: String(user.id),
				type: isGroupChat(item) ? 'group' : 'private'
			};
			initSocket(params);
		}
		refreshChatList();
	};

	// 发送消息
	const sendMessage = async (message: ISendMessage) => {
		// AI 助手对话：本地拦截生成回复
		if (isAssistantListItem(curChatInfo)) {
			const userMsg: IMessageItem = {
				sender_id: user.id,
				receiver_id: message.receiver_id,
				content: String(message.content),
				room: curChatInfo!.room,
				avatar: user.avatar,
				type: 'text',
				file_size: null,
				created_at: new Date()
			};
			setNewMessage(prev => [...prev, userMsg]);
			appendAiHistory(userMsg);
			// M1: 通过 hook 生成回复（后端代理 + 启发式回退）
			const replyText = await generateReply(String(message.content), aiHistory);
			const aiMsg: IMessageItem = {
				sender_id: 0,
				receiver_id: user.id,
				content: replyText,
				room: curChatInfo!.room,
				avatar: AI_AVATAR,
				type: 'text',
				file_size: null,
				created_at: new Date()
			};
			setNewMessage(prev => [...prev, aiMsg]);
			appendAiHistory(aiMsg);
			// 更新左侧最近会话预览
			setChatList(prev => {
				if (!curChatInfo) return prev;
				const updated = prev.map(it =>
					it.room === curChatInfo!.room
						? { ...it, lastMessage: replyText, updated_at: new Date(), type: 'text' }
						: it
				);
				if (!updated.find(it => it.room === curChatInfo!.room)) {
					return [
						{
							receiver_id: -100,
							name: '智能助手',
							receiver_username: AI_USERNAME,
							room: curChatInfo!.room,
							updated_at: new Date(),
							unreadCount: 0,
							lastMessage: replyText,
							type: 'text',
							avatar: AI_AVATAR
						},
						...updated
					];
				}
				return updated;
			});
			return;
		}
		// 普通会话：透传服务端
		socket.current?.send(JSON.stringify(message));
		refreshChatList();
	};

	const refreshChatList = async () => {
		try {
			const res = await getChatList();
			if (res.code === HttpStatus.SUCCESS) {
				setChatList(res.data);
			} else {
				showMessage('error', '获取消息列表失败');
			}
		} catch {
			showMessage('error', '获取消息列表失败');
		}
	};

	// L1: useEffect 依赖与 cleanup
	useEffect(() => {
		const init = async () => {
			await refreshChatList();
			if (initSelectedChat) {
				const updatedChatList = (await getChatList()).data;
				const targetIndex = updatedChatList.findIndex(
					item => item.room === initSelectedChat.room
				);
				if (targetIndex > -1) {
					const initChatInfo = updatedChatList.splice(targetIndex, 1)[0];
					setCurChatInfo(initChatInfo);
				} else {
					// L2: 变量改名避免遮蔽 newMessage state
					let newItem: IMessageListItem = {
						receiver_id: 0,
						name: '',
						room: initSelectedChat.room,
						updated_at: new Date(),
						unreadCount: 0,
						lastMessage: '暂无消息记录',
						type: 'text',
						avatar: initSelectedChat.avatar
					};
					if (isFriendInfo(initSelectedChat)) {
						newItem = Object.assign(newItem, {
							receiver_id: initSelectedChat.friend_user_id,
							name: initSelectedChat.remark,
							receiver_username: initSelectedChat.username
						});
					} else {
						newItem = Object.assign(newItem, {
							receiver_id: initSelectedChat.id,
							name: initSelectedChat.name
						});
					}
					setChatList([newItem, ...updatedChatList]);
					setCurChatInfo(newItem);
				}

				if (isAssistantInit(initSelectedChat)) {
					const welcome: IMessageItem = {
						sender_id: 0,
						receiver_id: user.id,
						content: '……你好呀。我是朝武芳乃。今天也请多关照。若是有什么在意的事，和我说说吧。',
						room: initSelectedChat.room,
						avatar: AI_AVATAR,
						type: 'text',
						file_size: null,
						created_at: new Date()
					};
					setHistoryMsg([welcome]);
					setAiHistory([welcome]);
				} else {
					const params: IConnectParams = {
						room: initSelectedChat.room,
						sender_id: String(user.id),
						type: isFriendInfo(initSelectedChat) ? 'private' : 'group'
					};
					initSocket(params);
				}
			}
		};
		init();
		// L1: cleanup 关闭 socket
		return () => {
			socket.current?.close();
		};
	}, []);

	useImperativeHandle(ref, () => ({
		refreshChatList
	}));

	return (
		<>
			<div className={styles.chatList}>
				<div className={styles.leftContainer}>
					<div className={styles.search}>
						<SearchContainer />
					</div>
					<div className={styles.list}>
						{chatList.length === 0 ? (
							<div className={styles.chat_none}> 暂无消息记录 </div>
						) : (
							chatList.map(item => (
								<div
									className={styles.chat_item}
									key={item.room}
									id={`chatList_${item.room}`}
									onClick={() => chooseRoom(item)}
									style={{
										backgroundColor:
											curChatInfo?.room === item.room ? 'rgba(0, 0, 0, 0.08)' : ''
									}}
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
												title={'未读消息' + item.unreadCount + '条'}
												arrow={false}
											>
												<div className={`iconfont ${StatusIconList[2].icon} ${styles.chat_unread}`}>
													<span>{item.unreadCount}</span>
												</div>
											</Tooltip>
										)}
									</div>
								</div>
							))
						)}
					</div>
				</div>
				<div className={styles.rightContainer}>
					{!curChatInfo ? (
						<img src="/yuzu.svg" alt="yuzu" style={{ width: '0.8rem', opacity: 0.25 }} />
					) : (
						<div className={styles.chat_window}>
							<div className={styles.chat_receiver}>
								<span>{curChatInfo.name}</span>
								{isGroupChat(curChatInfo) && (
									<span className={`icon iconfont icon-jinqunliaoliao ${styles.group_icon}`}></span>
								)}
							</div>
							<div className={styles.chat_content}>
								<ChatContainer historyMsg={historyMsg} newMsg={newMessage} />
							</div>
							<div className={styles.chat_input}>
								<ChatTool
									curChatInfo={curChatInfo}
									sendMessage={sendMessage}
									recentMessages={[...historyMsg, ...newMessage]}
									userProfile={user}
								/>
							</div>
						</div>
					)}
				</div>
			</div>
		</>
	);
});

Chat.displayName = 'Chat';
export default Chat;
