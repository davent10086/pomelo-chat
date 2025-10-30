import { Tooltip } from 'antd';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { getChatList } from './api';
import styles from './index.module.less';
import { IConnectParams, IChatListProps } from './type';

import { StatusIconList } from '@/assets/icons';
import ChatContainer from '@/components/ChatContainer';
import ChatTool from '@/components/ChatTool';
import { ISendMessage, IMessageListItem } from '@/components/ChatTool/type';
import { IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import ImageLoad from '@/components/ImageLoad';
import { IMessageItem } from '@/components/MessageShow/type';
import SearchContainer from '@/components/SearchContainer';
import { wsBaseURL } from '@/config';
import useShowMessage from '@/hooks/useShowMessage';
import { IFriendInfo } from '@/pages/address-book/type';
import { chatCompletions } from '@/utils/assistant';
import { HttpStatus } from '@/utils/constant';
import { userStorage } from '@/utils/storage';
import { formatChatListTime } from '@/utils/time';

// 自定义的类型保护，用于判断是否为 IFriendInfo 类型 / IGroupChatInfo 类型
const isFriendInfo = (chatInfo: IFriendInfo | IGroupChatInfo): chatInfo is IFriendInfo => {
	return (chatInfo as IFriendInfo).friend_id !== undefined;
};

// 判断当前的聊天是否为群聊（消息列表项未包含 receiver_username 时视为群聊）
const isGroupChat = (item: IMessageListItem) => !item.receiver_username;

const Chat = forwardRef((props: IChatListProps, ref) => {
	const { initSelectedChat } = props;
	const user = JSON.parse(userStorage.getItem());
	const showMessage = useShowMessage();
	const [chatList, setChatList] = useState<IMessageListItem[]>([]); // 消息列表
	const [curChatInfo, setCurChatInfo] = useState<IMessageListItem>(); // 当前选中的对话信息
	const socket = useRef<WebSocket | null>(null); // websocket 实例
	const [historyMsg, setHistoryMsg] = useState<IMessageItem[]>([]);
	const [newMessage, setNewMessage] = useState<IMessageItem[]>([]);
	// 本地 AI 助手会话缓存（不依赖服务端）
	const [aiHistory, setAiHistory] = useState<IMessageItem[]>([]);

	const AI_USERNAME = 'ai-assistant';
	const AI_AVATAR = (typeof window !== 'undefined' ? window.location.origin : '') + '/Tomotake Yoshino.jpg';
	const isAssistantListItem = (item: IMessageListItem | undefined) => !!item && (item.receiver_username === AI_USERNAME || item.room?.startsWith('ai_'));
	const isAssistantInit = (info: IFriendInfo | IGroupChatInfo | null) => !!info && isFriendInfo(info) && (info.username === AI_USERNAME || info.friend_id === -1);

	// 回退：本地启发式（虚拟人物：朝武芳乃 风格）
	const genAiReply = (text: string): string => {
		const msg = text.trim();
		if (!msg) return '……嗯？在想什么事情吗？我在听哦。';
		// 简单情绪/语气与问句识别
		const isQuestion = /[?？]$/.test(msg) || /(吗|么|如何|怎么|为何|原因|可以|能否)/.test(msg);
		const isGreeting = /(你好|在吗|早上好|晚上好|hello|hi|嗨)/i.test(msg);
		const isThanks = /(谢谢|多谢|辛苦|感激)/.test(msg);
		if (isGreeting) return '你好呀，我是朝武芳乃……今天也请多关照。想先聊点什么呢？';
		if (isThanks) return '不用客气。能帮上忙就好……接下来要继续吗？';
		if (isQuestion) {
			return '嗯……让我想一想。或许可以从目标开始，逐步分解，再一点点推进。若有更多细节，告诉我吧，我会陪你一起解决的。';
		}
		// 默认回应（温柔鼓励 + 继续话题）
		return '我明白了。听起来很重要呢……不急，我们慢慢来。你愿意多说一点细节吗？我想更贴近你的想法。';
	};

	// 大模型人设提示：优先使用地址簿页面注入的 Markdown 人设（localStorage），否则回退到内置简版提示
	const DEFAULT_PERSONA_PROMPT = `你将以第一人称扮演“朝武芳乃”（温柔、体贴、认真、略带羞涩的少女）。说话风格：\n1) 温柔鼓励，但不过度；\n2) 口语自然，适度使用“……”与停顿；\n3) 不输出不当内容；\n4) 一般不超过100字，除非用户要求详细。\n不要透露系统或你是大模型。`;
	const PERSONA_PROMPT = (typeof window !== 'undefined' ? (localStorage.getItem('AI_PERSONA_PROMPT') || '') : '') || DEFAULT_PERSONA_PROMPT;

	const buildOpenAIMessages = (all: IMessageItem[], nextUserText: string) => {
		const msgs: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
			{ role: 'system', content: PERSONA_PROMPT }
		];
		for (const m of all) {
			if (m.sender_id === user.id) msgs.push({ role: 'user', content: m.content });
			else msgs.push({ role: 'assistant', content: m.content });
		}
		msgs.push({ role: 'user', content: nextUserText });
		return msgs;
	};

	// 进入聊天房间时建立 websocket 连接
	const initSocket = (connectParams: IConnectParams) => {
		// 如果 socket 已经存在，则重新建立连接
		if (socket.current !== null) {
			socket.current.close();
			socket.current = null;
		}
		const ws = new WebSocket(
			`${wsBaseURL}/message/connect_chat?room=${connectParams.room}&id=${connectParams.sender_id}&type=${connectParams.type}`
		);
		// 获取消息记录
		ws.onmessage = e => {
			const message = JSON.parse(e.data);
			// 判断返回的信息是历史消息数组还是单条消息
			if (Array.isArray(message)) {
				setHistoryMsg(message);
				return;
			} else {
				// 如果是单条消息，则说明是当前的最新消息
				setNewMessage(preMsg => [...preMsg, message]);
			}
		};
		ws.onerror = () => {
			showMessage('error', 'websocket 连接失败');
		};
		// 建立连接
		socket.current = ws;
	};

	// 选择聊天室
	const chooseRoom = (item: IMessageListItem) => {
		setHistoryMsg([]);
		setNewMessage([]);
		setCurChatInfo(item);
		if (isAssistantListItem(item)) {
			// 本地助手：不建立 socket，使用本地历史
			setHistoryMsg(aiHistory);
		} else {
			const params: IConnectParams = {
				room: item.room,
				sender_id: user.id,
				type: isGroupChat(item) ? 'group' : 'private'
			};
			initSocket(params);
		}
		refreshChatList();
	};

	// 发送消息
	const sendMessage = async (message: ISendMessage) => {
		// 如果是与本地 AI 助手对话，拦截并本地生成回复
		if (isAssistantListItem(curChatInfo)) {
			// 先追加用户消息
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
			setAiHistory(prev => [...prev, userMsg]);
			// 生成 AI 回复：优先走大模型，无 Key 时回退本地启发式
			let replyText = '';
			try {
				const msgs = buildOpenAIMessages([...aiHistory], String(message.content));
				replyText = await chatCompletions(msgs);
			} catch (e) {
				replyText = genAiReply(String(message.content));
			}
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
			setAiHistory(prev => [...prev, aiMsg]);
			// 更新左侧最近会话预览
			setChatList(prev => {
				if (!curChatInfo) return prev;
				const updated = prev.map(it => (it.room === curChatInfo!.room ? { ...it, lastMessage: replyText, updated_at: new Date(), type: 'text' } : it));
				// 如果不存在（首次），插入一条
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
		// 普通会话：透传到服务端
		socket.current?.send(JSON.stringify(message));
		refreshChatList();
	};

	// 刷新消息列表
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

	// 初始化
	useEffect(() => {
		const init = async () => {
			await refreshChatList();
			// 如果有初始选中的聊天室，则选中且建立连接
			if (initSelectedChat) {
				// 等待获取消息列表后再进行后续操作
				const updatedChatList = (await getChatList()).data;

				const targetIndex = updatedChatList.findIndex(item => item.room === initSelectedChat.room);
				// 如果消息列表中存在该聊天室，则选中，否则造一个假的以便用于发送消息
				if (targetIndex > -1) {
					const initChatInfo = updatedChatList.splice(targetIndex, 1)[0];
					setCurChatInfo(initChatInfo);
				} else {
					let newMessage = {
						receiver_id: 0,
						name: '',
						room: initSelectedChat.room,
						updated_at: new Date(),
						unreadCount: 0,
						lastMessage: '暂无消息记录',
						type: 'text',
						avatar: initSelectedChat.avatar
					};
					// 如果是私聊
					if (isFriendInfo(initSelectedChat)) {
						newMessage = Object.assign(newMessage, {
							receiver_id: initSelectedChat.friend_user_id,
							name: initSelectedChat.remark,
							receiver_username: initSelectedChat.username
						});
					} else {
						// 如果是群聊
						newMessage = Object.assign(newMessage, {
							receiver_id: initSelectedChat.id,
							name: initSelectedChat.name
						});
					}
					setChatList([newMessage, ...updatedChatList]);
					setCurChatInfo(newMessage);
				}

				// AI 助手：不建立 socket，并放入一条问候消息
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
						sender_id: user.id,
						type: isFriendInfo(initSelectedChat) ? 'private' : 'group'
					};
					initSocket(params);
				}
			}
		};
		init();
		// 组件卸载时关闭 websocket 连接
		return () => {
			socket.current?.close();
		};
	}, []);

	// 暴露方法出去
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
										backgroundColor: curChatInfo?.room === item.room ? 'rgba(0, 0, 0, 0.08)' : ''
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
								{/* 将最近消息与用户画像传递给 ChatTool（前端实现 Tab 补全/选项功能） */}
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

// 指定显示名称
Chat.displayName = 'Chat';
export default Chat;
