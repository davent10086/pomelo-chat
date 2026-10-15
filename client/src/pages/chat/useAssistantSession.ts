import { useCallback, useEffect, useRef, useState } from 'react';
import {
	useAiAssistant,
	getAiAvatar,
	type AgentAction,
	type AgentEvent,
	type AgentReplyResult,
	type ActionStatus
} from '@/hooks/useAiAssistant';
import type { IUserInfo } from '@/utils/storage';
import type { IMessageItem } from '@/components/MessageShow/type';
import type { IMessageListItem, ISendMessage } from '@/components/ChatTool/type';
import { useAssistantActions } from './useAssistantActions';
import { useAssistantTasks } from './useAssistantTasks';
import { useAssistantMemory } from './useAssistantMemory';
import { RequestScope } from '@/utils/request-scope';
import type useShowMessage from '@/hooks/useShowMessage';

export function useAssistantSession(
	user: IUserInfo,
	showMessage: ReturnType<typeof useShowMessage>,
	onPreview: (room: string, text: string) => void
) {
	const [request] = useState(() => new RequestScope());
	useEffect(() => {
		request.resume();
		return () => request.dispose();
	}, [request, user.id]);
	const actions = useAssistantActions(request, showMessage);
	const tasks = useAssistantTasks(Number(user.id), request, actions, showMessage);
	const memory = useAssistantMemory(Number(user.id), request, actions, showMessage);
	const { memoryEnabled, memoryModalOpen } = memory;
	const [agentResult, setAgentResult] = useState<AgentReplyResult | null>(null);
	const [liveAgentEvents, setLiveAgentEvents] = useState<AgentEvent[]>([]);
	const [agentStreaming, setAgentStreaming] = useState(false);
	const activeAgentStream = useRef<string>();
	const streamAbort = useRef<AbortController>();
	const { aiHistory, appendAiHistory, setAiHistory, generateReply } = useAiAssistant(user);

	const [messages, setMessages] = useState<IMessageItem[]>([]);
	const [panelOpen, setPanelOpen] = useState(false);
	useEffect(
		() => () => {
			streamAbort.current?.abort();
			activeAgentStream.current = undefined;
		},
		[user.id]
	);
	const AI_AVATAR = getAiAvatar();

	const applyAgentStatus = async (action: AgentAction, status: ActionStatus) => {
		setAgentResult(previous => {
			if (!previous) return previous;
			const terminal = status.status === 'completed' || status.status === 'cancelled';
			const trace = `action:${action.type}:${status.status === 'completed' ? 'confirmed' : 'cancelled'}`;
			return {
				...previous,
				actions: terminal
					? previous.actions?.filter(item => item.confirmationId !== action.confirmationId)
					: previous.actions?.map(item =>
							item.confirmationId === action.confirmationId
								? { ...item, status: status.status }
								: item
						),
				toolTrace:
					terminal && !previous.toolTrace?.some(item => item.tool === trace)
						? [...(previous.toolTrace || []), { tool: trace, status: 'success' }]
						: previous.toolTrace
			};
		});
		if (status.status === 'completed' && action.type === 'create_tasks') await tasks.refresh();
		if (status.status === 'completed' && action.type === 'save_memory' && memoryModalOpen)
			await memory.refresh();
	};
	const confirmAgentAction = (action: AgentAction) =>
		actions.run(action, 'confirm', status => applyAgentStatus(action, status), {
			success:
				action.type === 'create_tasks'
					? 'Tasks created'
					: action.type === 'external_mcp'
						? 'Operation completed'
						: action.type === 'save_memory'
							? '记忆已保存'
							: 'Message sent'
		});
	const checkAgentAction = (action: AgentAction) =>
		actions.run(action, 'query', status => applyAgentStatus(action, status), {
			retry: true,
			error: '暂时无法查询操作状态'
		});
	const cancelAgentAction = (action: AgentAction) =>
		actions.run(action, 'cancel', status => applyAgentStatus(action, status), {
			success: 'Cancelled',
			error: '取消结果尚不确定，请查询操作状态'
		});

	const sendAssistantMessage = async (message: ISendMessage, curChatInfo: IMessageListItem) => {
		if (agentStreaming || activeAgentStream.current) throw new Error('回答正在生成');

		const userMsg: IMessageItem = {
			clientMsgId: `ai-user-${crypto.randomUUID()}`,
			sender_id: user.id,
			receiver_id: message.receiver_id,
			content: String(message.content),
			room: curChatInfo!.room,
			avatar: user.avatar,
			type: 'text',
			file_size: null,
			created_at: new Date()
		};
		setMessages(prev => [...prev, userMsg]);
		appendAiHistory(userMsg);
		setAgentResult(null);
		setLiveAgentEvents([]);
		setAgentStreaming(true);
		const contextMessages = [...aiHistory, userMsg];
		const streamId = `ai-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		streamAbort.current?.abort();
		streamAbort.current = new AbortController();
		activeAgentStream.current = streamId;
		let hasTextDelta = false;
		const aiMsg: IMessageItem = {
			clientMsgId: streamId,
			sender_id: 0,
			receiver_id: user.id,
			content: '正在思考…',
			room: curChatInfo!.room,
			avatar: AI_AVATAR,
			type: 'text',
			file_size: null,
			created_at: new Date()
		};
		setMessages(prev => [...prev, aiMsg]);
		const reply = await generateReply(String(message.content), contextMessages, {
			signal: streamAbort.current.signal,
			room: curChatInfo!.room,
			currentChatType: 'assistant',
			currentReceiverId: curChatInfo!.receiver_id,
			recentMessages: [...messages, userMsg],
			memoryEnabled,
			onDelta: text => {
				if (activeAgentStream.current !== streamId) return;
				hasTextDelta = true;
				setMessages(prev =>
					prev.map(item =>
						item.clientMsgId === streamId ? { ...item, content: text || '正在思考…' } : item
					)
				);
			},
			onEvent: event => {
				if (activeAgentStream.current !== streamId || !event.tool) return;
				setLiveAgentEvents(prev => [...prev, event].slice(-40));
				if (!hasTextDelta && event.type === 'tool_started') {
					setMessages(prev =>
						prev.map(item =>
							item.clientMsgId === streamId
								? { ...item, content: `正在调用工具：${event.tool}…` }
								: item
						)
					);
				}
			}
		});
		if (activeAgentStream.current !== streamId) return;
		const replyText = reply.text;
		if (activeAgentStream.current === streamId) {
			setAgentResult(reply);
			setAgentStreaming(false);
			if (reply.actions?.some(action => action.requiresConfirmation)) setPanelOpen(true);
		}
		setMessages(prev =>
			prev.map(item => (item.clientMsgId === streamId ? { ...item, content: replyText } : item))
		);
		appendAiHistory({ ...aiMsg, content: replyText });
		onPreview(curChatInfo.room, replyText);
		activeAgentStream.current = undefined;

		return;
	};

	const leave = useCallback(() => {
		request.invalidate();
		tasks.reset();
		memory.reset();
		actions.reset();
		streamAbort.current?.abort();
		activeAgentStream.current = undefined;
		setAgentStreaming(false);
		setLiveAgentEvents([]);
		setAgentResult(null);
		setPanelOpen(false);
	}, [request, tasks.reset, memory.reset, actions.reset]);
	const enter = () => {
		leave();
		setMessages(aiHistory);
		void tasks.refresh();
	};
	const welcome = (room: string) => {
		if (aiHistory.length) return;
		const item: IMessageItem = {
			sender_id: 0,
			receiver_id: user.id,
			content: 'Hello, I am the AI assistant. How can I help you?',
			room,
			avatar: AI_AVATAR,
			type: 'text',
			file_size: null,
			created_at: new Date()
		};
		setAiHistory([item]);
		setMessages([item]);
	};
	const selectTaskRoom = (room: string) => {
		request.invalidate();
		actions.reset();
		memory.reset(false);
		tasks.selectTaskRoom(room);
	};
	return {
		messages,
		panelOpen,
		togglePanel: () => setPanelOpen(value => !value),
		closePanel: () => setPanelOpen(false),
		enter,
		leave,
		welcome,
		selectTaskRoom,
		selectTaskIndexes: tasks.selectTaskIndexes,
		closeMemoryManager: memory.closeMemoryManager,
		agentResult,
		liveAgentEvents,
		agentStreaming,
		memoryEnabled,
		memoryModalOpen,
		memoryList: memory.memoryList,
		memoryLoading: memory.memoryLoading,
		assistantTasks: tasks.assistantTasks,
		taskLoading: tasks.taskLoading,
		pendingActionId: actions.pendingActionId,
		selectedTaskRoom: tasks.selectedTaskRoom,
		taskCandidateResult: tasks.taskCandidateResult,
		taskCandidateLoading: tasks.taskCandidateLoading,
		selectedTaskIndexes: tasks.selectedTaskIndexes,
		taskActionStatus: tasks.taskActionStatus,
		AI_AVATAR,
		openMemoryManager: memory.openMemoryManager,
		handleMemoryEnabledChange: memory.handleMemoryEnabledChange,
		deleteMemory: memory.deleteMemory,
		generateTaskCandidates: tasks.generateTaskCandidates,
		checkOrRetryTaskAction: tasks.checkOrRetryTaskAction,
		confirmSelectedTasks: tasks.confirmSelectedTasks,
		cancelSelectedTasks: tasks.cancelSelectedTasks,
		confirmAgentAction,
		checkAgentAction,
		cancelAgentAction,
		updateAssistantTask: tasks.updateAssistantTask,
		sendAssistantMessage
	};
}
