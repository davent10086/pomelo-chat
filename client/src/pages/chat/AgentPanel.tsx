import { Button, Empty, Switch, Tabs } from 'antd';

import styles from './index.module.less';
import { ActionControls, actionStatusLabels } from './ActionControls';
import type {
	AgentAction,
	AgentEvent,
	AgentReplyResult,
	AssistantTask,
	TaskCandidateResult,
	ActionStatus
} from '@/hooks/useAiAssistant';
import type { IMessageListItem } from '@/components/ChatTool/type';

interface AgentPanelProps {
	result: AgentReplyResult | null;
	liveEvents: AgentEvent[];
	streaming: boolean;
	tasks: AssistantTask[];
	tasksLoading: boolean;
	memoryEnabled: boolean;
	pendingActionId?: string;
	onMemoryEnabledChange: (checked: boolean) => void;
	onOpenMemoryManager: () => void;
	onInsertText: (text?: string) => void;
	onConfirmAction: (action: AgentAction) => void;
	onCancelAction: (action: AgentAction) => void;
	onCheckAction: (action: AgentAction) => void;
	onUpdateTask: (task: AssistantTask, completed: boolean) => void;
	conversations: IMessageListItem[];
	selectedRoom: string;
	onSelectRoom: (room: string) => void;
	onGenerateTasks: () => void;
	taskCandidateResult: TaskCandidateResult | null;
	taskCandidateLoading: boolean;
	selectedTaskIndexes: number[];
	onSelectedTaskIndexesChange: (indexes: number[]) => void;
	taskActionStatus: ActionStatus | null;
	onConfirmSelectedTasks: () => void;
	onCancelSelectedTasks: () => void;
	onCheckTaskStatus: () => void;
	onJumpToSource: (id: number) => void;
}

const AgentPanel = ({
	result,
	liveEvents,
	streaming,
	tasks,
	tasksLoading,
	memoryEnabled,
	pendingActionId,
	onMemoryEnabledChange,
	onOpenMemoryManager,
	onInsertText,
	onConfirmAction,
	onCancelAction,
	onCheckAction,
	onUpdateTask,
	conversations,
	selectedRoom,
	onSelectRoom,
	onGenerateTasks,
	taskCandidateResult,
	taskCandidateLoading,
	selectedTaskIndexes,
	onSelectedTaskIndexesChange,
	taskActionStatus,
	onConfirmSelectedTasks,
	onCancelSelectedTasks,
	onCheckTaskStatus,
	onJumpToSource
}: AgentPanelProps) => {
	const hasReplySuggestions = !!result?.replySuggestions?.length;
	const hasTodos = !!result?.todos?.length;
	const hasDraft = !!result?.draftMessage;
	const hasAgentTrace = !!result?.agentTrace?.length;
	const hasToolTrace = !!result?.toolTrace?.length;
	const hasAgentSteps = !!result?.agentSteps?.length;
	const confirmableActions =
		result?.actions?.filter(item => item.requiresConfirmation && item.confirmationId) || [];
	const liveTools = liveEvents.reduce<
		Array<{ tool: string; status: 'running' | 'success' | 'error'; durationMs?: number }>
	>((items, event) => {
		if (!event.tool || (event.type !== 'tool_started' && event.type !== 'tool_completed'))
			return items;
		const status =
			event.type === 'tool_started' ? 'running' : event.status === 'error' ? 'error' : 'success';
		const existing = items.find(item => item.tool === event.tool);
		if (existing) {
			existing.status = status;
			existing.durationMs = event.durationMs;
		} else items.push({ tool: event.tool, status, durationMs: event.durationMs });
		return items;
	}, []);

	return (
		<div className={styles.agentPanelContent}>
			<div className={styles.agentToolbar}>
				<div>
					<div className={styles.agentPanelTitle}>AI Copilot</div>
					<div className={styles.agentPanelSubtitle}>查看回复，按需处理待办与记忆</div>
				</div>
			</div>
			<div role="status" className={styles.taskHint}>
				{streaming
					? '正在生成回答…'
					: confirmableActions.some(action => !action.status || action.status === 'pending')
						? '有操作等待你的确认'
						: ''}
			</div>
			{confirmableActions.map(action => (
				<div className={styles.agentSection} key={action.confirmationId}>
					<div className={styles.agentTitle}>
						{action.type === 'create_tasks'
							? '待办操作'
							: action.type === 'external_mcp'
								? '外部工具操作'
								: action.type === 'save_memory'
									? '保存记忆'
									: '草稿发送'}
						：{actionStatusLabels[action.status || 'pending']}
					</div>
					{action.type === 'save_memory' && <p>{String(action.payload.content || '')}</p>}
					<ActionControls
						status={action.status || 'pending'}
						busy={pendingActionId === action.confirmationId}
						confirmLabel={
							action.type === 'create_tasks'
								? '确认创建'
								: action.type === 'external_mcp'
									? '确认执行'
									: action.type === 'save_memory'
										? '确认保存'
										: '确认发送'
						}
						onConfirm={() => onConfirmAction(action)}
						onCancel={() => onCancelAction(action)}
						onQuery={() => onCheckAction(action)}
					/>
				</div>
			))}

			<Tabs
				defaultActiveKey="reply"
				items={[
					{
						key: 'reply',
						label: '回复',
						children: (
							<>
								{result?.content && (
									<section className={styles.agentSection} aria-label="当前回答">
										<div className={styles.agentTitle}>当前回答</div>
										<p className={styles.agentAnswer}>{result.content}</p>
									</section>
								)}
								{!result && !streaming && (
									<Empty
										image={Empty.PRESENTED_IMAGE_SIMPLE}
										description="向 AI 发消息，查看回答与建议"
									/>
								)}
								{hasReplySuggestions && (
									<div className={styles.agentSection}>
										<div className={styles.agentTitle}>回复建议</div>
										<div className={styles.agentChips}>
											{result!.replySuggestions!.map(item => (
												<Button key={item} size="small" onClick={() => onInsertText(item)}>
													{item}
												</Button>
											))}
										</div>
									</div>
								)}

								{hasDraft && (
									<div className={styles.agentSection}>
										<div className={styles.agentTitle}>消息草稿</div>
										<button
											type="button"
											className={styles.agentDraft}
											onClick={() => onInsertText(result!.draftMessage)}
										>
											{result!.draftMessage}
										</button>
									</div>
								)}

								{(streaming ||
									liveTools.length > 0 ||
									hasAgentSteps ||
									hasAgentTrace ||
									hasToolTrace) && (
									<details className={styles.agentDetails}>
										<summary>执行详情</summary>
										{(streaming || liveTools.length > 0) && (
											<div
												className={`${styles.agentSection} ${styles.traceSection}`}
												aria-live="polite"
											>
												<div className={styles.agentTitle}>
													实时工具{streaming ? ' · 执行中' : ''}
												</div>
												<div className={styles.traceList}>
													{liveTools.length === 0 && streaming && (
														<span className={styles.agentTraceItem}>等待工具调用或模型回复</span>
													)}
													{liveTools.map(item => (
														<span
															key={item.tool}
															className={`${styles.toolTraceItem} ${styles[`traceStatus_${item.status === 'running' ? 'planned' : item.status}`] || ''}`}
														>
															{item.tool} ·{' '}
															{item.status === 'running'
																? '运行中'
																: item.status === 'success'
																	? '完成'
																	: '失败'}
															{item.durationMs !== undefined ? ` (${item.durationMs}ms)` : ''}
														</span>
													))}
												</div>
											</div>
										)}
										{(hasAgentSteps || hasAgentTrace || hasToolTrace) && (
											<div className={`${styles.agentSection} ${styles.traceSection}`}>
												<div className={styles.agentTitle}>执行轨迹</div>
												<div className={styles.traceList}>
													{hasAgentSteps
														? result!.agentSteps!.map(item => (
																<span
																	className={`${styles.agentTraceItem} ${styles[`traceStatus_${item.status}`] || ''}`}
																	key={`agent-step-${item.agent}`}
																	title={
																		item.detail
																			? `${item.detail}${item.durationMs !== undefined ? ` (${item.durationMs}ms)` : ''}`
																			: undefined
																	}
																>
																	{item.agent}
																</span>
															))
														: result?.agentTrace?.map(item => (
																<span className={styles.agentTraceItem} key={`agent-${item}`}>
																	{item}
																</span>
															))}
													{result?.toolTrace?.map((item, index) => (
														<span
															className={`${styles.toolTraceItem} ${styles[`traceStatus_${item.status}`] || ''}`}
															key={`tool-${item.tool}-${index}`}
														>
															{item.tool}
														</span>
													))}
												</div>
											</div>
										)}
									</details>
								)}
							</>
						)
					},
					{
						key: 'tasks',
						label: '待办',
						children: (
							<>
								<div className={styles.agentSection}>
									<div className={styles.agentTitle}>聊天事项卡片</div>
									<select
										aria-label="选择聊天会话"
										value={selectedRoom}
										onChange={event => onSelectRoom(event.target.value)}
									>
										<option value="">选择一个会话</option>
										{conversations.map(item => (
											<option key={item.room} value={item.room}>
												{item.name || item.room}
											</option>
										))}
									</select>
									<Button
										size="small"
										disabled={!selectedRoom}
										loading={taskCandidateLoading}
										onClick={onGenerateTasks}
									>
										整理事项
									</Button>
									{taskCandidateResult && taskCandidateResult.todos.length === 0 && (
										<p>最近消息中没有明确事项。</p>
									)}
									{taskCandidateResult?.todos.map((todo, index) => (
										<div
											className={`${styles.todoItem} ${styles.taskCandidateItem}`}
											key={`${todo.title}-${index}`}
										>
											<label>
												<input
													type="checkbox"
													checked={selectedTaskIndexes.includes(index)}
													disabled={taskActionStatus?.status !== 'pending'}
													onChange={event =>
														onSelectedTaskIndexesChange(
															event.target.checked
																? [...selectedTaskIndexes, index]
																: selectedTaskIndexes.filter(item => item !== index)
														)
													}
												/>
												{todo.title}
											</label>
											{todo.assignee && <em>{todo.assignee}</em>}
											{todo.due && <em>{todo.due}</em>}
											{todo.sources.map(source => (
												<button
													type="button"
													key={source.id}
													onClick={() => onJumpToSource(source.id)}
												>
													原消息 #{source.id}：{source.content}
												</button>
											))}
										</div>
									))}
									{taskCandidateResult?.action && (
										<ActionControls
											status={taskActionStatus?.status || 'pending'}
											busy={pendingActionId === taskCandidateResult.action.confirmationId}
											confirmLabel="确认保存所选"
											queryLabel="查询结果／重试确认"
											canConfirm={selectedTaskIndexes.length > 0}
											showStatus
											onConfirm={onConfirmSelectedTasks}
											onCancel={onCancelSelectedTasks}
											onQuery={onCheckTaskStatus}
										/>
									)}
								</div>
								{hasTodos && (
									<div className={styles.agentSection}>
										<div className={styles.agentTitle}>待办建议</div>
										<div className={styles.todoList}>
											{result!.todos!.map((todo, index) => (
												<div className={styles.todoItem} key={`${todo.title}-${index}`}>
													<span>{todo.title}</span>
													{todo.assignee && <em>{todo.assignee}</em>}
													{todo.due && <em>{todo.due}</em>}
												</div>
											))}
										</div>
									</div>
								)}

								{tasks.length > 0 && (
									<div className={styles.agentSection}>
										<div className={styles.agentTitle}>我的待办</div>
										<div className={styles.todoList}>
											{tasks.slice(0, 8).map(task => (
												<div className={styles.todoItem} key={task.id}>
													<Button
														size="small"
														type={task.status === 'completed' ? 'default' : 'link'}
														onClick={() => onUpdateTask(task, task.status !== 'completed')}
													>
														{task.status === 'completed' ? '已完成' : '完成'}
													</Button>
													<span>{task.title}</span>
													{task.due && <em>{task.due}</em>}
												</div>
											))}
											{tasksLoading && <span className={styles.taskHint}>加载中...</span>}
										</div>
									</div>
								)}

								{tasksLoading && tasks.length === 0 && <p role="status">正在加载待办…</p>}
								{!tasksLoading && tasks.length === 0 && (
									<p className={styles.taskHint}>暂无已保存的待办，可从聊天记录中整理事项。</p>
								)}
							</>
						)
					},
					{
						key: 'memory',
						label: '记忆',
						children: (
							<section className={styles.agentSection}>
								<div className={styles.memoryControls}>
									<span>在回复中参考已保存记忆</span>
									<Switch
										aria-label="在回复中参考已保存记忆"
										size="small"
										checked={memoryEnabled}
										onChange={onMemoryEnabledChange}
									/>
								</div>
								<p className={styles.taskHint}>
									只有你确认保存的内容才会成为记忆，可随时查看和删除。
								</p>
								<Button onClick={onOpenMemoryManager}>管理记忆</Button>
							</section>
						)
					}
				]}
			/>
		</div>
	);
};

export default AgentPanel;
