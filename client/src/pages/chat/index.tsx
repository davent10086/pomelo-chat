import { Tooltip } from 'antd';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { createPortal } from 'react-dom';

import AgentPanel from './AgentPanel';
import { getChatHistory, getChatList, markChatRead } from './api';
import styles from './index.module.less';
import MemoryManager from './MemoryManager';
import { AssistantMemoryItem, IConnectParams, IChatListProps, IChatRef } from './type';
import { useChatSocket } from './useChatSocket';

import { StatusIconList } from '@/assets/icons';
import ChatContainer from '@/components/ChatContainer';
import ChatTool from '@/components/ChatTool';
import { ISendMessage, IMessageListItem } from '@/components/ChatTool/type';
import { IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import ImageLoad from '@/components/ImageLoad';
import { IMessageItem } from '@/components/MessageShow/type';
import SearchContainer from '@/components/SearchContainer';
import { AI_USERNAME, getAiAvatar, useAiAssistant, type AgentAction, type AgentReplyResult, type AssistantTask } from '@/hooks/useAiAssistant';
import useShowMessage from '@/hooks/useShowMessage';
import { IFriendInfo } from '@/pages/address-book/type';
import { HttpStatus } from '@/utils/constant';
import request from '@/utils/request';
import { userStorage } from '@/utils/storage';
import { formatChatListTime } from '@/utils/time';

// 闂傚倷鑳堕崢褔銆冩惔銏㈩洸婵犲﹤鐗婇崑鈺呮煟閹伴潧澧伴柍缁樻礀椤法鎹勯搹鍦姰濡炪値鍋撶粻鎾诲蓟濞戙垹惟闁靛鍠栭崜顔剧磽娴ｈ櫣甯涚€光偓閹间胶宓?
const isFriendInfo = (chatInfo: IFriendInfo | IGroupChatInfo): chatInfo is IFriendInfo => {
	return (chatInfo as IFriendInfo).friend_id !== undefined;
};

const isGroupChat = (item: IMessageListItem) => !item.receiver_username;

// M4: forwardRef 濠电姷鏁搁崑娑⑺囬幍顔剧煓闁硅揪闄勯崐鐢告煟閹达絾顥夌紒鈧畝鍕厸鐎广儱娲﹂弳鈺冪磼閳ь剚绻呯弧绛?缂傚倸鍊风欢锟犲磻婢舵劦鏁嬬憸鏃堝箖濡ゅ懏鐓ラ悗锝庡厴閺?IChatRef
const Chat = forwardRef<IChatRef, IChatListProps>((props, ref) => {
	const { initSelectedChat } = props;
	// H11: userStorage.getItem() 闂佽姘﹂～澶愭偤閺囩姳鐒婃い蹇撴瀹曟煡鏌熸潏鍓х暠闁绘劕锕弻锝夊箛椤掍讲鏋欓梺鎼炲€楁繛鈧柟?
	const user = userStorage.getItem();
	const showMessage = useShowMessage();
	const {
		historyMsg,
		newMessage,
		setHistoryMsg,
		setNewMessage,
		historyCursor,
		hasMoreHistory,
		setHistoryCursor,
		setHasMoreHistory,
		resetMessages,
		connect: connectSocket,
		send: sendSocketMessage,
		closeSocket
	} = useChatSocket({ onError: message => showMessage('error', message) });
	const [chatList, setChatList] = useState<IMessageListItem[]>([]);
	const [curChatInfo, setCurChatInfo] = useState<IMessageListItem>();
	const [agentResult, setAgentResult] = useState<AgentReplyResult | null>(null);
	const [insertTextRequest, setInsertTextRequest] = useState<{ id: number; text: string }>();
	const [memoryEnabled, setMemoryEnabled] = useState(
		() => localStorage.getItem('AI_MEMORY_ENABLED') !== 'false'
	);
	const [memoryModalOpen, setMemoryModalOpen] = useState(false);
	const [memoryList, setMemoryList] = useState<AssistantMemoryItem[]>([]);
	const [memoryLoading, setMemoryLoading] = useState(false);
	const [assistantTasks, setAssistantTasks] = useState<AssistantTask[]>([]);
	const [taskLoading, setTaskLoading] = useState(false);
	const [pendingActionId, setPendingActionId] = useState<string>();
	const [historyLoading, setHistoryLoading] = useState(false);
	const [agentPanelOpen, setAgentPanelOpen] = useState(false);

	// M1: 婵犵數鍋犻幓顏嗙礊閳ь剚绻涙径瀣鐎?AI 闂傚倷绀侀幉锟犲蓟閿熺姴鐤炬繝濠傚濞?hook
	const { aiHistory, appendAiHistory, setAiHistory, generateReply } = useAiAssistant(user);

	const AI_AVATAR = getAiAvatar();
	const isAssistantListItem = (item: IMessageListItem | undefined) =>
		!!item && (item.receiver_username === AI_USERNAME || item.room?.startsWith('ai_'));
	const isAssistantInit = (info: IFriendInfo | IGroupChatInfo | null) =>
		!!info && isFriendInfo(info) && (info.username === AI_USERNAME || info.friend_id === -1);
	const pinAssistantConversation = (items: IMessageListItem[]) => {
		const existing = items.find(isAssistantListItem);
		const assistant: IMessageListItem = existing || {
			receiver_id: -100,
			receiver_username: AI_USERNAME,
			name: 'AI助手',
			room: `ai_${user.id}`,
			updated_at: new Date(),
			unreadCount: 0,
			lastMessage: '随时为你总结、规划和执行操作',
			type: 'text',
			avatar: AI_AVATAR
		};
		return [assistant, ...items.filter(item => item.room !== assistant.room)];
	};

	const insertAgentText = (text?: string) => {
		if (!text) return;
		setInsertTextRequest({ id: Date.now(), text });
	};

	const callAgentTool = async <T,>(name: string, args: Record<string, unknown>) => {
		const res = await request.post<
			{ name: string; args: Record<string, unknown> },
			{ name: string; result: T }
		>('/assistant/agent/tools/call', { name, args });
		return res.data.data.result;
	};

	const refreshMemories = async () => {
		setMemoryLoading(true);
		try {
			const result = await callAgentTool<{ memories: AssistantMemoryItem[] }>('search_memory', {
				query: '',
				limit: 20
			});
			setMemoryList(result.memories || []);
		} catch {
			showMessage('error', 'Unable to load memories');
		} finally {
			setMemoryLoading(false);
		}
	};

	const openMemoryManager = async () => {
		setMemoryModalOpen(true);
		await refreshMemories();
	};

	const handleMemoryEnabledChange = (checked: boolean) => {
		setMemoryEnabled(checked);
		localStorage.setItem('AI_MEMORY_ENABLED', String(checked));
	};

	const deleteMemory = async (content: string) => {
		try {
			await callAgentTool('forget_memory', { query: content });
			showMessage('success', 'Memory deleted');
			await refreshMemories();
		} catch {
			showMessage('error', 'Unable to delete memory');
		}
	};

	const refreshAssistantTasks = async () => {
		setTaskLoading(true);
		try {
			const res = await request.get<{ tasks: AssistantTask[] }>('/assistant/tasks');
			setAssistantTasks(res.data.data.tasks || []);
		} catch {
			showMessage('error', 'Unable to load tasks');
		} finally {
			setTaskLoading(false);
		}
	};

	const confirmAgentAction = async (action: AgentAction) => {
		if (!action.confirmationId) return;
		setPendingActionId(action.confirmationId);
		try {
			await request.post('/assistant/actions/confirm', { confirmationId: action.confirmationId });
			showMessage('success', action.type === 'create_tasks' ? 'Tasks created' : 'Message sent');
			setAgentResult(previous => previous ? {
				...previous,
				actions: previous.actions?.filter(item => item.confirmationId !== action.confirmationId),
				toolTrace: [...(previous.toolTrace || []), { tool: `action:${action.type}:confirmed`, status: 'success' }]
			} : previous);
			if (action.type === 'create_tasks') await refreshAssistantTasks();
		} catch {
			showMessage('error', 'Unable to confirm action');
		} finally {
			setPendingActionId(undefined);
		}
	};

	const cancelAgentAction = async (action: AgentAction) => {
		if (!action.confirmationId) return;
		setPendingActionId(action.confirmationId);
		try {
			await request.post('/assistant/actions/cancel', { confirmationId: action.confirmationId });
			setAgentResult(previous => previous ? {
				...previous,
				actions: previous.actions?.filter(item => item.confirmationId !== action.confirmationId),
				toolTrace: [...(previous.toolTrace || []), { tool: `action:${action.type}:cancelled`, status: 'success' }]
			} : previous);
			showMessage('success', 'Cancelled');
		} catch {
			showMessage('error', 'Unable to cancel action');
		} finally {
			setPendingActionId(undefined);
		}
	};

	const updateAssistantTask = async (task: AssistantTask, completed: boolean) => {
		try {
			await request.request({ method: 'patch', url: `/assistant/tasks/${task.id}`, data: { completed } });
			await refreshAssistantTasks();
		} catch {
			showMessage('error', 'Unable to update task');
		}
	};

	// 闂佽娴烽崑锝夊磹濞戞ǚ鏋嶉柨婵嗩槹閸嬬喐绻涢幋娆忕仾闁搞倕鍊搁埞鎴︽偐閹绘巻鍋撻懜鐢殿洸?websocket闂傚倷鐒︾€笛呯矙閹存繐鑰?: 闂傚倷绀佸﹢閬嶅储瑜旈獮鏍敃閿旇棄浠?token闂?
	const initSocket = (connectParams: IConnectParams) => connectSocket(connectParams);

	const chooseRoom = (item: IMessageListItem) => {
		resetMessages();
		setAgentResult(null);
		setCurChatInfo(item);
		if (isAssistantListItem(item)) {
			setAgentPanelOpen(false);
			setHistoryMsg(aiHistory);
			refreshAssistantTasks();
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

	const currentChatType = (item: IMessageListItem) => isGroupChat(item) ? 'group' : 'private';

	const reportRead = async (item: IMessageListItem | undefined, messages: IMessageItem[] = []) => {
		if (!item || isAssistantListItem(item)) return;
		const latestSeq = messages.reduce((max, msg) => Math.max(max, Number(msg.room_seq || 0)), 0);
		try {
			await markChatRead({ room: item.room, type: currentChatType(item), roomSeq: latestSeq || undefined });
		} catch {
			/* read cursor is best-effort */
		}
	};

	// 闂傚倷绀侀幉锟犳偡閿曞倸鍨傞柛褎顨呴悞鍨亜閹达絾纭堕柛鏂跨Ф缁辨帗寰勭仦钘夊箣濡?
	const sendMessage = async (message: ISendMessage) => {
		// AI 闂傚倷绀侀幉锟犲蓟閿熺姴鐤炬繝濠傚濞呯姵绻濇繝鍌涘櫝闁稿鎹囬幃钘夆枔閹稿孩鏆為梻浣风串缂傛氨鍒掑▎鎾虫瀬鐎广儱鎷嬪鈺傘亜閹捐泛鏋戦悗姘▕濮婃椽妫冮埡渚囨喘婵犫拃鍕垫畼闁逞屽墯閸濆酣宕愬┑瀣祦閻庯綆鍣弫鍌炴煕閳╁叐鎴濃枍閵忋倖鈷戦柣鐔稿閹界娀鏌涢弮鈧ú鏍弲闂佸搫绉查崝宀€娆?
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
			setAgentResult(null);
			const contextMessages = [...aiHistory, userMsg];
			// M1: 闂傚倸鍊风欢锟犲磻閸涱喚鈹嶉柧蹇氼潐瀹?hook 闂傚倷鐒﹂惇褰掑垂婵犳艾绐楅柟鐗堟緲閸ㄥ倹鎱ㄥΟ鎸庣【闁绘劕锕弻锝夊箛椤掍讲鏋欏┑鈩冨絻椤兘寮婚妸銉㈡婵☆垵宕甸鍞僥nt + 闂傚倷绀侀幉锟犳嚌閹灐褰掓倻缁涘鏅滃銈嗗笂閼冲爼銆呴悜鑺ョ叆婵犻潧妫欐径鍕煕?+ 闂傚倷绀侀幉锟犲礄瑜版帒鍨傞柟宄拌娴滃綊鏌涚仦鎯у毈闁搞倖娲熼悡顐﹀炊閵婏箑闉嶇紓浣插亾闁逞屽墴濮婄粯绗熼崶褌绨梺绋款儐閹瑰洭寮?
			const reply = await generateReply(String(message.content), contextMessages, {
				room: curChatInfo!.room,
				currentChatType: 'assistant',
				currentReceiverId: curChatInfo!.receiver_id,
				recentMessages: [...historyMsg, ...newMessage, userMsg],
				memoryEnabled
			});
			const replyText = reply.text;
			setAgentResult(reply);
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
			// 闂傚倷绀侀幖顐⒚洪妶澶嬪仱闁靛ň鏅涢拑鐔封攽閻樻彃浜為柛鐔锋嚇閺屻劑寮埀顒傗偓绗涘啠鏋嶉柣妯肩帛閻撴盯鏌涢锝堝濞存粓绠栭弻鈩冨緞閸℃ɑ鐝曢梺鎼炲妼绾绢厼危閹版澘绠ユい鏃囨閻濇澘鈹戦悩缁樻锭妞ゆ垶鍔欏鎶藉即閵忊€充画?
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
							name: 'AI Assistant',
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
		// 闂傚倷绀侀幖顐﹀箯鐎ｎ喖闂柨婵嗩槸閻掑灚銇勯幒宥堝厡闁绘搩鍨崇槐鎺撴綇閵娿儺妫嗛梺褰掝棑婵挳鍩為幋锕€绠婚柛鎾茶兌瀹曞爼姊婚崒娆戣窗闁稿瀚幑銏⑩偓锝庡墯椤洟鏌涢锝嗙閻庢艾顦遍埀顒€绠嶉崕閬嶅箠鎼搭煉缍栭柕鍫濇川绾?
		const sendResult = sendSocketMessage(message);
		const pendingMessage: IMessageItem = {
			clientMsgId: sendResult.clientMsgId,
			sender_id: message.sender_id,
			receiver_id: message.receiver_id,
			content: String(message.content),
			room: curChatInfo!.room,
			avatar: message.avatar,
			type: message.type,
			file_size: null,
			created_at: new Date(),
			status: sendResult.ok ? 'pending' : 'failed'
		};
		setNewMessage(prev => [...prev, pendingMessage]);
		if (!sendResult.ok) showMessage('error', '消息连接未就绪，请稍后重试');
		refreshChatList();
	};

	const loadMoreHistory = async () => {
		if (!curChatInfo || !historyCursor || historyLoading || !hasMoreHistory) return;
		setHistoryLoading(true);
		try {
			const type = isGroupChat(curChatInfo) ? 'group' : 'private';
			const res = await getChatHistory({ room: curChatInfo.room, type, beforeId: historyCursor, limit: 30 });
			if (res.code === HttpStatus.SUCCESS) {
				setHistoryMsg(prev => [...(res.data.messages || []), ...prev]);
				setHistoryCursor(res.data.nextBeforeId);
				setHasMoreHistory(Boolean(res.data.hasMore));
				await reportRead(curChatInfo, res.data.messages || []);
			} else {
				showMessage('error', 'Unable to load history');
			}
		} catch {
			showMessage('error', 'Unable to load history');
		} finally {
			setHistoryLoading(false);
		}
	};

	useEffect(() => {
		if (!curChatInfo || isAssistantListItem(curChatInfo)) return;
		const timer = setTimeout(() => {
			reportRead(curChatInfo, [...historyMsg, ...newMessage]);
		}, 300);
		return () => clearTimeout(timer);
	}, [curChatInfo?.room, historyMsg.length, newMessage.length]);

	const refreshChatList = async () => {
		try {
			const res = await getChatList();
			if (res.code === HttpStatus.SUCCESS) {
				setChatList(pinAssistantConversation(res.data));
			} else {
			showMessage('error', 'Unable to refresh chat list');
			}
		} catch {
			showMessage('error', 'Unable to refresh chat list');
		}
	};

	// L1: useEffect 婵犵數鍋為幐鑽ゅ枈瀹ュ洦宕查柛鈩冪懅閻鏌涢埄鍐剧劷闁?cleanup
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
					// L2: 闂傚倷绀侀幉锟犳偡閿曞倹鏅濋柕蹇嬪€曢梻顖涚箾瀹割喕绨荤紓浣叉櫊閺岋綁鎮㈤崫鍕垫毉闂佺锕ユ繛濠傤潖濞差亶鏁嗛柍褜鍓熼幃妯衡攽鐎ｎ亜鍋嶉梺闈涚墕椤︿即鎮為崗绗轰簻闁哄啠鍋撻悗绗涘洤绾?newMessage state
					let newItem: IMessageListItem = {
						receiver_id: 0,
						name: '',
						room: initSelectedChat.room,
						updated_at: new Date(),
						unreadCount: 0,
						lastMessage: 'No message history',
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
						content: 'Hello, I am the AI assistant. How can I help you?',
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
		// L1: cleanup 闂傚倷鑳堕…鍫㈡崲閹寸偟绠惧┑鐘蹭迹?socket
		return () => {
				closeSocket();
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
							<div className={styles.chat_none}>暂无会话</div>
						) : (
							chatList.map(item => (
								<button
									type="button"
									className={`${styles.chat_item} ${isAssistantListItem(item) ? styles.assistant_item : ''}`}
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
													? '[Image]'
													: item.type === 'video'
														? '[Video]'
														: item.type === 'file'
															? '[File]'
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
												title={`Unread messages: ${item.unreadCount}`}
												arrow={false}
											>
												<div className={`iconfont ${StatusIconList[2].icon} ${styles.chat_unread}`}>
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
				<div className={styles.rightContainer}>
					{!curChatInfo ? (
						<img src="/ai-assistant.svg" alt="AI assistant" style={{ width: '0.8rem', opacity: 0.25 }} />
					) : (
						<div className={styles.chat_window}>
							<div className={styles.chat_receiver}>
								<span>{curChatInfo.name}</span>
								{isGroupChat(curChatInfo) && (
									<span className={`icon iconfont icon-jinqunliaoliao ${styles.group_icon}`}></span>
								)}
								{isAssistantListItem(curChatInfo) && (
									<button
										type="button"
										className={styles.agentPanelToggle}
										onClick={() => setAgentPanelOpen(open => !open)}
										aria-expanded={agentPanelOpen}
									>
										{agentPanelOpen ? '收起 Copilot' : '打开 Copilot'}
									</button>
								)}
							</div>
									<div className={styles.chat_body}>
										<div className={styles.chat_main}>
									<div className={styles.chat_content}>
										<ChatContainer
											historyMsg={historyMsg}
											newMsg={newMessage}
											hasMoreHistory={!isAssistantListItem(curChatInfo) && hasMoreHistory}
											historyLoading={historyLoading}
											onLoadMoreHistory={loadMoreHistory}
										/>
									</div>
									<div className={styles.chat_input}>
										<ChatTool
											curChatInfo={curChatInfo}
											sendMessage={sendMessage}
											recentMessages={[...historyMsg, ...newMessage]}
											userProfile={user}
											externalInsertText={insertTextRequest}
											/>
										</div>
									</div>
										{false && agentPanelOpen && isAssistantListItem(curChatInfo) && (
											<aside className={styles.agentPanel} aria-label="AI Copilot 助手面板">
												<AgentPanel
													result={agentResult}
													tasks={assistantTasks}
													tasksLoading={taskLoading}
													memoryEnabled={memoryEnabled}
													pendingActionId={pendingActionId}
													onMemoryEnabledChange={handleMemoryEnabledChange}
													onOpenMemoryManager={openMemoryManager}
													onInsertText={insertAgentText}
													onConfirmAction={confirmAgentAction}
													onCancelAction={cancelAgentAction}
													onUpdateTask={updateAssistantTask}
												/>
											</aside>
										)}
							</div>
						</div>
					)}
				</div>
			</div>
			<MemoryManager
				open={memoryModalOpen}
				memories={memoryList}
				loading={memoryLoading}
				memoryEnabled={memoryEnabled}
				onClose={() => setMemoryModalOpen(false)}
				onMemoryEnabledChange={handleMemoryEnabledChange}
				 onDelete={deleteMemory}
			/>
			{agentPanelOpen && curChatInfo && isAssistantListItem(curChatInfo) && createPortal(
				<aside className={styles.agentPanelFloating} aria-label="AI Copilot 助手面板">
					<AgentPanel
						result={agentResult}
						tasks={assistantTasks}
						tasksLoading={taskLoading}
						memoryEnabled={memoryEnabled}
						pendingActionId={pendingActionId}
						onMemoryEnabledChange={handleMemoryEnabledChange}
						onOpenMemoryManager={openMemoryManager}
						onInsertText={insertAgentText}
						onConfirmAction={confirmAgentAction}
						onCancelAction={cancelAgentAction}
						onUpdateTask={updateAssistantTask}
					/>
				</aside>,
				document.body
			)}
		</>
	);
});

Chat.displayName = 'Chat';
export default Chat;
