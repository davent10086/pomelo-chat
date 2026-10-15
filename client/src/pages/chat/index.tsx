import ConversationList from './ConversationList';
import { SearchOutlined } from '@ant-design/icons';
import { useConversationList } from './useConversationList';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';

import { useAssistantSession } from './useAssistantSession';
import MessageSearch from './MessageSearch';
import { useNormalConversation } from './useNormalConversation';
import { mergeMessages } from '@/utils/message-merge';
import AgentPanel from './AgentPanel';
import styles from './index.module.less';
import MemoryManager from './MemoryManager';
import { IChatListProps, IChatRef } from './type';

import ChatContainer from '@/components/ChatContainer';
import ChatTool from '@/components/ChatTool';
import { ISendMessage, IMessageListItem } from '@/components/ChatTool/type';
import { IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import { AI_USERNAME, getAiAvatar } from '@/hooks/useAiAssistant';
import useShowMessage from '@/hooks/useShowMessage';
import { IFriendInfo } from '@/pages/address-book/type';
import { userStorage } from '@/utils/storage';

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
	const onChatError = useCallback(
		(message: string) => showMessage('error', message),
		[showMessage]
	);
	const [curChatInfo, setCurChatInfo] = useState<IMessageListItem>();
	const [focusMessageId, setFocusMessageId] = useState<number>();
	const isAssistantListItem = (item: IMessageListItem | undefined) =>
		!!item && (item.receiver_username === AI_USERNAME || item.room?.startsWith('ai_'));
	const assistantSelected = isAssistantListItem(curChatInfo);
	const normalRoom = curChatInfo && !assistantSelected ? curChatInfo.room : undefined;
	const normalType = curChatInfo && isGroupChat(curChatInfo) ? 'group' : 'private';
	useEffect(() => {
		const bridge = window.pomeloDesktop;
		if (!bridge) return;
		void bridge.publishChat(normalRoom && curChatInfo ? {
			room: normalRoom, type: normalType, receiverId: curChatInfo.receiver_id, name: curChatInfo.name
		} : null).catch(() => undefined);
		return () => { void bridge.publishChat(null).catch(() => undefined); };
	}, [normalRoom, normalType, curChatInfo?.receiver_id, curChatInfo?.name]);
	const normal = useNormalConversation(
		normalRoom,
		normalType,
		Number(user.id),
		onChatError,
		focusMessageId
	);
	const { chatList, ensureConversation, updatePreview, refreshChatList } = useConversationList(
		Number(user.id),
		getAiAvatar(),
		onChatError
	);
	const assistant = useAssistantSession(user, showMessage, updatePreview);
	const {
		agentResult,
		liveAgentEvents,
		agentStreaming,
		memoryEnabled,
		memoryModalOpen,
		memoryList,
		memoryLoading,
		assistantTasks,
		taskLoading,
		pendingActionId,
		selectedTaskRoom,
		taskCandidateResult,
		taskCandidateLoading,
		selectedTaskIndexes,
		taskActionStatus,
		openMemoryManager,
		handleMemoryEnabledChange,
		deleteMemory,
		generateTaskCandidates,
		checkOrRetryTaskAction,
		confirmSelectedTasks,
		cancelSelectedTasks,
		confirmAgentAction,
		checkAgentAction,
		cancelAgentAction,
		updateAssistantTask,
		sendAssistantMessage
	} = assistant;
	const agentPanelOpen = assistant.panelOpen;
	const historyMsg = assistantSelected ? assistant.messages : normal.historyMsg;
	const newMessage = assistantSelected ? [] : normal.newMessage;

	const [insertTextRequest, setInsertTextRequest] = useState<{ id: number; text: string; room: string }>();
	const insertAgentText = (text?: string) => {
		if (text && curChatInfo)
			setInsertTextRequest(previous => ({
				id: (previous?.id || 0) + 1, text, room: curChatInfo.room
			}));
	};

	const chooseRoom = (item: IMessageListItem, sourceId?: number) => {
		if (curChatInfo?.room === item.room) {
			if (sourceId && !isAssistantListItem(item)) void normal.locate(sourceId);
			return;
		}
		normal.leave();
		assistant.leave();
		setInsertTextRequest(undefined);
		setFocusMessageId(sourceId);
		setCurChatInfo(item);
		if (isAssistantListItem(item)) assistant.enter();
		void refreshChatList();
	};

	const jumpToTaskSource = (id: number) => {
		const item = chatList.find(chat => chat.room === selectedTaskRoom);
		if (item) chooseRoom(item, id);
	};

	// 闂傚倷绀侀幉锟犳偡閿曞倸鍨傞柛褎顨呴悞鍨亜閹达絾纭堕柛鏂跨Ф缁辨帗寰勭仦钘夊箣濡?
	const sendMessage = async (message: ISendMessage) => {
		if (assistantSelected && curChatInfo) await sendAssistantMessage(message, curChatInfo);
		else {
			await normal.send(message);
			void refreshChatList();
		}
	};
	useEffect(() => {
		let disposed = false;
		void refreshChatList().then(items => {
			if (disposed || !initSelectedChat) return;
			let item = items?.find(chat => chat.room === initSelectedChat.room);
			if (!item) {
				item = {
					receiver_id: isFriendInfo(initSelectedChat)
						? initSelectedChat.friend_user_id
						: initSelectedChat.id,
					name: isFriendInfo(initSelectedChat) ? initSelectedChat.remark : initSelectedChat.name,
					receiver_username: isFriendInfo(initSelectedChat) ? initSelectedChat.username : undefined,
					room: initSelectedChat.room,
					avatar: initSelectedChat.avatar,
					updated_at: new Date(),
					unreadCount: 0,
					lastMessage: 'No message history',
					type: 'text'
				};
				ensureConversation(item);
			}
			setCurChatInfo(item);
			if (isAssistantListItem(item)) {
				assistant.enter();
				assistant.welcome(item.room);
			}
		});
		return () => {
			disposed = true;
		};
	}, []);

	useImperativeHandle(ref, () => ({
		refreshChatList: async () => {
			await refreshChatList();
		}
	}));

	return (
		<>
			<div className={`${styles.chatList} ${curChatInfo ? styles.activeConversation : ''}`}>
				<ConversationList chatList={chatList} curChatInfo={curChatInfo} chooseRoom={chooseRoom} />
				<div className={styles.rightContainer}>
					{!curChatInfo ? (
						<img
							src="/ai-assistant.svg"
							alt="AI assistant"
							style={{ width: '0.8rem', opacity: 0.25 }}
						/>
					) : (
						<div className={styles.chat_window}>
							<div className={styles.chat_receiver}>
								<button
									type="button"
									className={styles.mobileBack}
									onClick={() => {
										assistant.closePanel();
										setCurChatInfo(undefined);
										normal.leave();
										assistant.leave();
									}}
								>
									会话列表
								</button>
								<span className={styles.receiverName}>{curChatInfo.name}</span>
								{!isAssistantListItem(curChatInfo) && (
									<button type="button" className={styles.searchToggle} aria-label="搜索聊天记录" title="搜索聊天记录" onClick={normal.toggleSearch}>
										<SearchOutlined />
									</button>
								)}
								{isGroupChat(curChatInfo) && (
									<span className={`icon iconfont icon-jinqunliaoliao ${styles.group_icon}`}></span>
								)}
								{isAssistantListItem(curChatInfo) && (
									<button
										type="button"
										className={styles.agentPanelToggle}
										onClick={() => assistant.togglePanel()}
										aria-expanded={agentPanelOpen}
									>
										{agentPanelOpen ? '收起 Copilot' : '打开 Copilot'}
									</button>
								)}
							</div>
							<div
								className={`${styles.chat_body} ${normal.searchOpen ? styles.searchPanelOpen : ''} ${
									agentPanelOpen && isAssistantListItem(curChatInfo) ? styles.agentPanelOpen : ''
								}`}
							>
								<div className={styles.chat_main}>
									<div className={styles.chat_content}>
										{normal.locating && (
											<div>
												<button
													type="button"
													onClick={() => {
														normal.returnToLatest();
														setFocusMessageId(undefined);
													}}
												>
													返回最新消息
												</button>
												{normal.hasAfter && (
													<button
														type="button"
														disabled={normal.loading}
														onClick={() => void normal.loadNewer()}
													>
														加载较新消息
													</button>
												)}
											</div>
										)}
										<ChatContainer
											key={`${curChatInfo.room}:${normal.locating ? 'history' : 'live'}`}
											onRetry={normal.retry}
											onCancelRetry={normal.cancel}
											onAtBottomChange={normal.onAtBottom}
											historyMsg={historyMsg}
											newMsg={newMessage}
											hasMoreHistory={!assistantSelected && normal.hasMoreHistory}
											historyLoading={normal.loading}
											onLoadMoreHistory={normal.loadOlder}
											focusMessageId={normal.focusId}
											onInsertText={insertAgentText}
										/>
									</div>
									<div className={styles.chat_input}>
										<ChatTool
											key={`${user.id}:${curChatInfo.room}`}
											curChatInfo={curChatInfo}
											sendMessage={sendMessage}
											recentMessages={assistantSelected ? assistant.messages : normal.messages}
											userProfile={user}
											externalInsertText={insertTextRequest?.room === curChatInfo.room ? insertTextRequest : undefined}
										/>
									</div>
								</div>
								{normal.searchOpen && normalRoom && (
									<MessageSearch
										key={normalRoom}
										room={normalRoom}
										type={normalType}
										messages={[...historyMsg, ...newMessage]}
										onLocate={id => {
											void normal.locate(id);
										}}
										onClose={normal.closeSearch}
									/>
								)}
								{agentPanelOpen && isAssistantListItem(curChatInfo) && (
									<aside className={styles.agentPanel} aria-label="AI Copilot 助手面板">
										<button
											type="button"
											className={styles.agentPanelClose}
											onClick={() => assistant.closePanel()}
										>
											返回聊天
										</button>
										<AgentPanel
											result={agentResult}
											liveEvents={liveAgentEvents}
											streaming={agentStreaming}
											tasks={assistantTasks}
											tasksLoading={taskLoading}
											memoryEnabled={memoryEnabled}
											pendingActionId={pendingActionId}
											onMemoryEnabledChange={handleMemoryEnabledChange}
											onOpenMemoryManager={openMemoryManager}
											onInsertText={insertAgentText}
											onConfirmAction={confirmAgentAction}
											onCancelAction={cancelAgentAction}
											onCheckAction={checkAgentAction}
											onUpdateTask={updateAssistantTask}
											conversations={chatList.filter(item => !isAssistantListItem(item))}
											selectedRoom={selectedTaskRoom}
											onSelectRoom={room => {
												assistant.selectTaskRoom(room);
											}}
											onGenerateTasks={generateTaskCandidates}
											taskCandidateResult={taskCandidateResult}
											taskCandidateLoading={taskCandidateLoading}
											selectedTaskIndexes={selectedTaskIndexes}
											onSelectedTaskIndexesChange={assistant.selectTaskIndexes}
											taskActionStatus={taskActionStatus}
											onConfirmSelectedTasks={confirmSelectedTasks}
											onCancelSelectedTasks={cancelSelectedTasks}
											onCheckTaskStatus={checkOrRetryTaskAction}
											onJumpToSource={jumpToTaskSource}
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
				onClose={assistant.closeMemoryManager}
				onMemoryEnabledChange={handleMemoryEnabledChange}
				onDelete={deleteMemory}
			/>
		</>
	);
});

Chat.displayName = 'Chat';
export default Chat;
