import { Modal } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
	useAiAssistant,
	getAiAvatar,
	type AgentAction,
	type AgentEvent,
	type AgentReplyResult,
	type AssistantTask,
	type TaskCandidateResult,
	type ActionStatus
} from '@/hooks/useAiAssistant';
import type { IUserInfo } from '@/utils/storage';
import type { IMessageItem } from '@/components/MessageShow/type';
import type { IMessageListItem, ISendMessage } from '@/components/ChatTool/type';
import type { AssistantMemoryItem } from './type';
import { RequestScope } from '@/utils/request-scope';
import type useShowMessage from '@/hooks/useShowMessage';

export function useAssistantSession(
	user: IUserInfo,
	showMessage: ReturnType<typeof useShowMessage>,
	onPreview: (room: string, text: string) => void
) {
	const request = useRef(new RequestScope()).current;
	const dialogs = useRef(new Set<ReturnType<typeof Modal.confirm>>());
	useEffect(() => {
		request.resume();
		return () => {
			request.dispose();
			for (const dialog of dialogs.current) dialog.destroy();
			dialogs.current.clear();
		};
	}, [request, user.id]);
	const [agentResult, setAgentResult] = useState<AgentReplyResult | null>(null);
	const [liveAgentEvents, setLiveAgentEvents] = useState<AgentEvent[]>([]);
	const [agentStreaming, setAgentStreaming] = useState(false);
	const activeAgentStream = useRef<string>();
	const streamAbort = useRef<AbortController>();
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
	const [selectedTaskRoom, setSelectedTaskRoom] = useState('');
	const [taskCandidateResult, setTaskCandidateResult] = useState<TaskCandidateResult | null>(null);
	const [taskCandidateLoading, setTaskCandidateLoading] = useState(false);
	const [selectedTaskIndexes, setSelectedTaskIndexes] = useState<number[]>([]);
	const [taskActionStatus, setTaskActionStatus] = useState<ActionStatus | null>(null);
	const taskCardStorageKey = `AI_TASK_CARD_${user.id}`;
	useEffect(() => {
		const version = request.version;
		try {
			const saved = sessionStorage.getItem(taskCardStorageKey);
			if (!saved) return;
			const value = JSON.parse(saved) as {
				room: string;
				data: TaskCandidateResult;
				indexes: number[];
			};
			if (!value.data?.action?.confirmationId) return;
			setSelectedTaskRoom(value.room);
			setTaskCandidateResult(value.data);
			setSelectedTaskIndexes(value.indexes);
			request
				.get<ActionStatus>(`/assistant/actions/${value.data.action.confirmationId}`)
				.then(res => {
					if (request.isCurrent(version)) setTaskActionStatus(res.data.data);
				})
				.catch(() => {
					if (!request.isCurrent(version)) return;
					setTaskActionStatus({
						confirmationId: value.data.action!.confirmationId!,
						type: 'create_tasks',
						status: 'executing'
					});
				});
		} catch {
			sessionStorage.removeItem(taskCardStorageKey);
		}
	}, [taskCardStorageKey, request]);
	useEffect(() => {
		if (taskCandidateResult?.action?.confirmationId) {
			sessionStorage.setItem(
				taskCardStorageKey,
				JSON.stringify({
					room: selectedTaskRoom,
					data: taskCandidateResult,
					indexes: selectedTaskIndexes
				})
			);
		} else {
			sessionStorage.removeItem(taskCardStorageKey);
		}
	}, [taskCardStorageKey, selectedTaskRoom, taskCandidateResult, selectedTaskIndexes]);

	// M1: 婵犵數鍋犻幓顏嗙礊閳ь剚绻涙径瀣鐎?AI 闂傚倷绀侀幉锟犲蓟閿熺姴鐤炬繝濠傚濞?hook
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
	const insertAgentText = (text?: string) => {
		if (!text) return;
		setInsertTextRequest({ id: Date.now(), text });
	};

	const callAgentTool = async <T>(name: string, args: Record<string, unknown>) => {
		const res = await request.post<
			{ name: string; args: Record<string, unknown> },
			{ name: string; result: T }
		>('/assistant/agent/tools/call', { name, args });
		return res.data.data.result;
	};

	const refreshMemories = async () => {
		const version = request.version;
		setMemoryLoading(true);
		try {
			const result = await callAgentTool<{ memories: AssistantMemoryItem[] }>('search_memory', {
				query: '',
				limit: 20
			});
			setMemoryList(result.memories || []);
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', 'Unable to load memories');
		} finally {
			if (request.isCurrent(version)) setMemoryLoading(false);
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

	const deleteMemory = async (item: AssistantMemoryItem) => {
		const version = request.version;
		try {
			const action = await callAgentTool<AgentAction>('forget_memory', { id: item.id });
			const confirmationId = action.confirmationId;
			if (!confirmationId) throw new Error('Missing confirmation id');
			const dialog = Modal.confirm({
				title: '确认删除这条记忆？',
				content: String(action.payload.content || item.content),
				okText: '删除',
				okButtonProps: { danger: true },
				cancelText: '取消',
				afterClose: () => dialogs.current.delete(dialog),
				onOk: async () => {
					if (!request.isCurrent(version)) return;
					try {
						const confirmed = (
							await request.post<{ confirmationId: string }, ActionStatus>(
								'/assistant/actions/confirm',
								{ confirmationId }
							)
						).data.data;
						if (confirmed.status !== 'completed') throw new Error('Memory deletion not completed');
						showMessage('success', 'Memory deleted');
						await refreshMemories();
					} catch (error) {
						if (!request.isCurrent(version)) return;
						showMessage('error', 'Unable to delete memory');
						throw error;
					}
				},
				onCancel: () => {
					if (request.isCurrent(version))
						void request
							.post('/assistant/actions/cancel', { confirmationId })
							.catch(() => undefined);
				}
			});
			dialogs.current.add(dialog);
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', 'Unable to delete memory');
		}
	};

	const refreshAssistantTasks = async () => {
		const version = request.version;
		setTaskLoading(true);
		try {
			const res = await request.get<{ tasks: AssistantTask[] }>('/assistant/tasks');
			setAssistantTasks(res.data.data.tasks || []);
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', 'Unable to load tasks');
		} finally {
			if (request.isCurrent(version)) setTaskLoading(false);
		}
	};

	const generateTaskCandidates = async () => {
		const version = request.version;
		if (!selectedTaskRoom) return;
		setTaskCandidateLoading(true);
		try {
			const res = await request.post<{ room: string }, TaskCandidateResult>(
				'/assistant/agent/task-candidates',
				{ room: selectedTaskRoom }
			);
			const data = res.data.data;
			setTaskCandidateResult(data);
			setSelectedTaskIndexes([]);
			setTaskActionStatus(
				data.action?.confirmationId
					? { confirmationId: data.action.confirmationId, type: 'create_tasks', status: 'pending' }
					: null
			);
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', '无法整理事项，请稍后重试');
		} finally {
			if (request.isCurrent(version)) setTaskCandidateLoading(false);
		}
	};

	const checkTaskActionStatus = async () => {
		const version = request.version;
		const id = taskCandidateResult?.action?.confirmationId;
		if (!id) return;
		try {
			const res = await request.get<ActionStatus>(`/assistant/actions/${id}`);
			setTaskActionStatus(res.data.data);
			if (res.data.data.status === 'completed') await refreshAssistantTasks();
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', '暂时无法查询操作状态');
		}
	};

	const checkOrRetryTaskAction = async () => {
		const version = request.version;
		const id = taskCandidateResult?.action?.confirmationId;
		if (!id) return;
		try {
			const status = (await request.get<ActionStatus>(`/assistant/actions/${id}`)).data.data;
			setTaskActionStatus(status);
			if (status.status === 'completed') await refreshAssistantTasks();
			if (status.retryable) {
				const result = await request.post<{ confirmationId: string }, ActionStatus>(
					'/assistant/actions/confirm',
					{ confirmationId: id }
				);
				setTaskActionStatus(result.data.data);
				if (result.data.data.status === 'completed') await refreshAssistantTasks();
			}
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', '结果尚不确定，请稍后再次查询');
		}
	};

	const confirmSelectedTasks = async () => {
		const version = request.version;
		const id = taskCandidateResult?.action?.confirmationId;
		if (!id || !selectedTaskIndexes.length) return;
		setPendingActionId(id);
		try {
			const res = await request.post<
				{ confirmationId: string; taskIndexes: number[] },
				ActionStatus
			>('/assistant/actions/confirm', { confirmationId: id, taskIndexes: selectedTaskIndexes });
			setTaskActionStatus(res.data.data);
			if (res.data.data.status === 'completed') await refreshAssistantTasks();
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', '结果尚不确定，请查询操作状态');
			await checkTaskActionStatus();
		} finally {
			if (request.isCurrent(version)) setPendingActionId(undefined);
		}
	};

	const cancelSelectedTasks = async () => {
		const version = request.version;
		const id = taskCandidateResult?.action?.confirmationId;
		if (!id) return;
		try {
			await request.post('/assistant/actions/cancel', { confirmationId: id });
			setTaskActionStatus({ confirmationId: id, type: 'create_tasks', status: 'cancelled' });
		} catch {
			if (!request.isCurrent(version)) return;
			await checkTaskActionStatus();
		}
	};

	const confirmAgentAction = async (action: AgentAction) => {
		const version = request.version;
		if (!action.confirmationId) return;
		setPendingActionId(action.confirmationId);
		try {
			const res = await request.post<{ confirmationId: string }, ActionStatus>(
				'/assistant/actions/confirm',
				{ confirmationId: action.confirmationId }
			);
			const status = res.data.data;
			if (status.status === 'completed')
				showMessage(
					'success',
					action.type === 'create_tasks'
						? 'Tasks created'
						: action.type === 'external_mcp'
							? 'Operation completed'
							: action.type === 'save_memory'
								? '记忆已保存'
								: 'Message sent'
				);
			setAgentResult(previous =>
				previous
					? {
							...previous,
							actions:
								status.status === 'completed'
									? previous.actions?.filter(item => item.confirmationId !== action.confirmationId)
									: previous.actions?.map(item =>
											item.confirmationId === action.confirmationId
												? { ...item, status: status.status }
												: item
										),
							toolTrace:
								status.status === 'completed'
									? [
											...(previous.toolTrace || []),
											{ tool: `action:${action.type}:confirmed`, status: 'success' }
										]
									: previous.toolTrace
						}
					: previous
			);
			if (status.status === 'completed' && action.type === 'create_tasks')
				await refreshAssistantTasks();
			if (status.status === 'completed' && action.type === 'save_memory' && memoryModalOpen)
				await refreshMemories();
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', '结果尚不确定，请查询操作状态');
			await checkAgentAction(action);
		} finally {
			if (request.isCurrent(version)) setPendingActionId(undefined);
		}
	};

	const checkAgentAction = async (action: AgentAction) => {
		const version = request.version;
		if (!action.confirmationId) return;
		try {
			let status = (await request.get<ActionStatus>(`/assistant/actions/${action.confirmationId}`))
				.data.data;
			if (status.retryable)
				status = (
					await request.post<{ confirmationId: string }, ActionStatus>(
						'/assistant/actions/confirm',
						{ confirmationId: action.confirmationId }
					)
				).data.data;
			setAgentResult(previous =>
				previous
					? {
							...previous,
							actions:
								status.status === 'completed' || status.status === 'cancelled'
									? previous.actions?.filter(item => item.confirmationId !== action.confirmationId)
									: previous.actions?.map(item =>
											item.confirmationId === action.confirmationId
												? { ...item, status: status.status }
												: item
										)
						}
					: previous
			);
			if (status.status === 'completed' && action.type === 'create_tasks')
				await refreshAssistantTasks();
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', '暂时无法查询操作状态');
		}
	};

	const cancelAgentAction = async (action: AgentAction) => {
		const version = request.version;
		if (!action.confirmationId) return;
		setPendingActionId(action.confirmationId);
		try {
			await request.post('/assistant/actions/cancel', { confirmationId: action.confirmationId });
			setAgentResult(previous =>
				previous
					? {
							...previous,
							actions: previous.actions?.filter(
								item => item.confirmationId !== action.confirmationId
							),
							toolTrace: [
								...(previous.toolTrace || []),
								{ tool: `action:${action.type}:cancelled`, status: 'success' }
							]
						}
					: previous
			);
			showMessage('success', 'Cancelled');
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', '取消结果尚不确定，请查询操作状态');
			await checkAgentAction(action);
		} finally {
			if (request.isCurrent(version)) setPendingActionId(undefined);
		}
	};

	const updateAssistantTask = async (task: AssistantTask, completed: boolean) => {
		const version = request.version;
		try {
			await request.request({
				method: 'patch',
				url: `/assistant/tasks/${task.id}`,
				data: { completed }
			});
			await refreshAssistantTasks();
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', 'Unable to update task');
		}
	};

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
		// M1: 闂傚倸鍊风欢锟犲磻閸涱喚鈹嶉柧蹇氼潐瀹?hook 闂傚倷鐒﹂惇褰掑垂婵犳艾绐楅柟鐗堟緲閸ㄥ倹鎱ㄥΟ鎸庣【闁绘劕锕弻锝夊箛椤掍讲鏋欏┑鈩冨絻椤兘寮婚妸銉㈡婵☆垵宕甸鍞僥nt + 闂傚倷绀侀幉锟犳嚌閹灐褰掓倻缁涘鏅滃銈嗗笂閼冲爼銆呴悜鑺ョ叆婵犻潧妫欐径鍕煕?+ 闂傚倷绀侀幉锟犲礄瑜版帒鍨傞柟宄拌娴滃綊鏌涚仦鎯у毈闁搞倖娲熼悡顐﹀炊閵婏箑闉嶇紓浣插亾闁逞屽墴濮婄粯绗熼崶褌绨梺绋款儐閹瑰洭寮?
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
		// 闂傚倷绀侀幖顐⒚洪妶澶嬪仱闁靛ň鏅涢拑鐔封攽閻樻彃浜為柛鐔锋嚇閺屻劑寮埀顒傗偓绗涘啠鏋嶉柣妯肩帛閻撴盯鏌涢锝堝濞存粓绠栭弻鈩冨緞閸℃ɑ鐝曢梺鎼炲妼绾绢厼危閹版澘绠ユい鏃囨閻濇澘鈹戦悩缁樻锭妞ゆ垶鍔欏鎶藉即閵忊€充画?
		onPreview(curChatInfo.room, replyText);
		activeAgentStream.current = undefined;

		return;
	};

	const leave = useCallback(() => {
		request.invalidate();
		for (const dialog of dialogs.current) dialog.destroy();
		dialogs.current.clear();
		setTaskCandidateLoading(false);
		setTaskLoading(false);
		setMemoryLoading(false);
		setPendingActionId(undefined);
		setMemoryModalOpen(false);
		streamAbort.current?.abort();
		activeAgentStream.current = undefined;
		setAgentStreaming(false);
		setLiveAgentEvents([]);
		setAgentResult(null);
		setPanelOpen(false);
	}, [request]);
	const enter = () => {
		leave();
		setMessages(aiHistory);
		void refreshAssistantTasks();
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
		setTaskCandidateLoading(false);
		setTaskLoading(false);
		setMemoryLoading(false);
		setPendingActionId(undefined);
		setSelectedTaskRoom(room);
		setTaskCandidateResult(null);
		setTaskActionStatus(null);
		setSelectedTaskIndexes([]);
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
		selectTaskIndexes: (indexes: number[]) => setSelectedTaskIndexes(indexes),
		closeMemoryManager: () => setMemoryModalOpen(false),
		agentResult,
		liveAgentEvents,
		agentStreaming,
		insertTextRequest,
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
		AI_AVATAR,
		insertAgentText,
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
	};
}
