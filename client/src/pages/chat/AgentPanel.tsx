import { Button, Empty, Switch } from 'antd';

import styles from './index.module.less';
import type { AgentAction, AgentReplyResult, AssistantTask } from '@/hooks/useAiAssistant';

interface AgentPanelProps {
	result: AgentReplyResult | null;
	tasks: AssistantTask[];
	tasksLoading: boolean;
	memoryEnabled: boolean;
	pendingActionId?: string;
	onMemoryEnabledChange: (checked: boolean) => void;
	onOpenMemoryManager: () => void;
	onInsertText: (text?: string) => void;
	onConfirmAction: (action: AgentAction) => void;
	onCancelAction: (action: AgentAction) => void;
	onUpdateTask: (task: AssistantTask, completed: boolean) => void;
}

const AgentPanel = ({
	result,
	tasks,
	tasksLoading,
	memoryEnabled,
	pendingActionId,
	onMemoryEnabledChange,
	onOpenMemoryManager,
	onInsertText,
	onConfirmAction,
	onCancelAction,
	onUpdateTask
}: AgentPanelProps) => {
	const hasReplySuggestions = !!result?.replySuggestions?.length;
	const hasTodos = !!result?.todos?.length;
	const hasDraft = !!result?.draftMessage;
	const hasAgentTrace = !!result?.agentTrace?.length;
	const hasToolTrace = !!result?.toolTrace?.length;
	const hasAgentSteps = !!result?.agentSteps?.length;
	const confirmableActions = result?.actions?.filter(item => item.requiresConfirmation && item.confirmationId) || [];
	const hasContent = hasReplySuggestions || hasTodos || hasDraft || hasAgentTrace || hasToolTrace || hasAgentSteps || tasks.length || confirmableActions.length;

	return (
		<aside className={styles.agentPanel}>
			<div className={styles.agentToolbar}>
				<div>
					<div className={styles.agentPanelTitle}>AI Copilot</div>
					<div className={styles.agentPanelSubtitle}>总结、待办、建议回复和工具轨迹</div>
				</div>
				<div className={styles.memoryControls}>
					<span>记忆</span>
					<Switch size="small" checked={memoryEnabled} onChange={onMemoryEnabledChange} />
					<Button size="small" onClick={onOpenMemoryManager}>管理</Button>
				</div>
			</div>

			<div className={styles.workflow}>
				<span className={styles.workflowItem}>规划</span>
				<span className={styles.workflowArrow}>→</span>
				<span className={styles.workflowItem}>工具</span>
				<span className={styles.workflowArrow}>→</span>
				<span className={styles.workflowItem}>结果</span>
				<span className={styles.workflowArrow}>→</span>
				<span className={styles.workflowItem}>确认</span>
			</div>

			{!hasContent && (
				<div className={styles.agentEmpty}>
					<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="向 AI 发消息后，这里会显示建议、待办和执行轨迹" />
				</div>
			)}

			{hasReplySuggestions && (
				<div className={styles.agentSection}>
					<div className={styles.agentTitle}>回复建议</div>
					<div className={styles.agentChips}>
						{result!.replySuggestions!.map(item => <Button key={item} size="small" onClick={() => onInsertText(item)}>{item}</Button>)}
					</div>
				</div>
			)}

			{hasDraft && (
				<div className={styles.agentSection}>
					<div className={styles.agentTitle}>消息草稿</div>
					<button type="button" className={styles.agentDraft} onClick={() => onInsertText(result!.draftMessage)}>{result!.draftMessage}</button>
				</div>
			)}

			{confirmableActions.map(action => (
				<div className={styles.agentSection} key={action.confirmationId}>
					<div className={styles.agentTitle}>{action.type === 'create_tasks' ? '待办操作' : '草稿发送'}</div>
					<div className={styles.actionControls}>
						<Button size="small" type="primary" loading={pendingActionId === action.confirmationId} onClick={() => onConfirmAction(action)}>
							{action.type === 'create_tasks' ? '确认创建' : '确认发送'}
						</Button>
						<Button size="small" disabled={pendingActionId === action.confirmationId} onClick={() => onCancelAction(action)}>取消</Button>
					</div>
				</div>
			))}

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
								<Button size="small" type={task.status === 'completed' ? 'default' : 'link'} onClick={() => onUpdateTask(task, task.status !== 'completed')}>
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

			{(hasAgentSteps || hasAgentTrace || hasToolTrace) && (
				<div className={`${styles.agentSection} ${styles.traceSection}`}>
					<div className={styles.agentTitle}>执行轨迹</div>
					<div className={styles.traceList}>
						{hasAgentSteps
							? result!.agentSteps!.map(item => (
									<span className={`${styles.agentTraceItem} ${styles[`traceStatus_${item.status}`] || ''}`} key={`agent-step-${item.agent}`} title={item.detail ? `${item.detail}${item.durationMs !== undefined ? ` (${item.durationMs}ms)` : ''}` : undefined}>
										{item.agent}
									</span>
								))
							: result?.agentTrace?.map(item => <span className={styles.agentTraceItem} key={`agent-${item}`}>{item}</span>)}
						{result?.toolTrace?.map((item, index) => (
							<span className={`${styles.toolTraceItem} ${styles[`traceStatus_${item.status}`] || ''}`} key={`tool-${item.tool}-${index}`}>{item.tool}</span>
						))}
					</div>
				</div>
			)}
		</aside>
	);
};

export default AgentPanel;
