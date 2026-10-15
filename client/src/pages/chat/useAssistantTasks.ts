import { useCallback, useEffect, useState } from 'react';
import type { ActionStatus, AssistantTask, TaskCandidateResult } from '@/hooks/useAiAssistant';
import type useShowMessage from '@/hooks/useShowMessage';
import type { RequestScope } from '@/utils/request-scope';
import type { AssistantActions } from './useAssistantActions';

export function useAssistantTasks(
	userId: number,
	request: RequestScope,
	actions: AssistantActions,
	showMessage: ReturnType<typeof useShowMessage>
) {
	const [assistantTasks, setAssistantTasks] = useState<AssistantTask[]>([]);
	const [taskLoading, setTaskLoading] = useState(false);
	const [selectedTaskRoom, setSelectedTaskRoom] = useState('');
	const [taskCandidateResult, setTaskCandidateResult] = useState<TaskCandidateResult | null>(null);
	const [taskCandidateLoading, setTaskCandidateLoading] = useState(false);
	const [selectedTaskIndexes, setSelectedTaskIndexes] = useState<number[]>([]);
	const [taskActionStatus, setTaskActionStatus] = useState<ActionStatus | null>(null);
	const storageKey = `AI_TASK_CARD_${userId}`;
	useEffect(() => {
		const version = request.version;
		try {
			const saved = sessionStorage.getItem(storageKey);
			if (!saved) return;
			const value = JSON.parse(saved) as {
				room: string;
				data: TaskCandidateResult;
				indexes: number[];
			};
			const confirmationId = value.data?.action?.confirmationId;
			if (!confirmationId) return;
			setSelectedTaskRoom(value.room);
			setTaskCandidateResult(value.data);
			setSelectedTaskIndexes(value.indexes);
			void request
				.get<ActionStatus>(`/assistant/actions/${confirmationId}`)
				.then(res => {
					if (request.isCurrent(version)) setTaskActionStatus(res.data.data);
				})
				.catch(() => {
					if (request.isCurrent(version))
						setTaskActionStatus({ confirmationId, type: 'create_tasks', status: 'executing' });
				});
		} catch {
			/* Storage is optional; all saved tasks remain on the server. */
		}
	}, [storageKey, request]);
	useEffect(() => {
		try {
			if (taskCandidateResult?.action?.confirmationId)
				sessionStorage.setItem(
					storageKey,
					JSON.stringify({
						room: selectedTaskRoom,
						data: taskCandidateResult,
						indexes: selectedTaskIndexes
					})
				);
			else sessionStorage.removeItem(storageKey);
		} catch {
			/* A blocked storage write must not prevent reviewing the current card. */
		}
	}, [storageKey, selectedTaskRoom, taskCandidateResult, selectedTaskIndexes]);
	const refresh = async () => {
		const version = request.version;
		setTaskLoading(true);
		try {
			const res = await request.get<{ tasks: AssistantTask[] }>('/assistant/tasks');
			setAssistantTasks(res.data.data.tasks || []);
		} catch {
			if (request.isCurrent(version)) showMessage('error', 'Unable to load tasks');
		} finally {
			if (request.isCurrent(version)) setTaskLoading(false);
		}
	};
	const generateTaskCandidates = async () => {
		if (!selectedTaskRoom) return;
		const version = request.version;
		setTaskCandidateLoading(true);
		try {
			const data = (
				await request.post<{ room: string }, TaskCandidateResult>(
					'/assistant/agent/task-candidates',
					{ room: selectedTaskRoom }
				)
			).data.data;
			setTaskCandidateResult(data);
			setSelectedTaskIndexes([]);
			setTaskActionStatus(
				data.action?.confirmationId
					? { confirmationId: data.action.confirmationId, type: 'create_tasks', status: 'pending' }
					: null
			);
		} catch {
			if (request.isCurrent(version)) showMessage('error', '无法整理事项，请稍后重试');
		} finally {
			if (request.isCurrent(version)) setTaskCandidateLoading(false);
		}
	};
	const applyStatus = async (status: ActionStatus) => {
		setTaskActionStatus(status);
		if (status.status === 'completed') await refresh();
	};
	const checkOrRetryTaskAction = () =>
		taskCandidateResult?.action
			? actions.run(taskCandidateResult.action, 'query', applyStatus, { retry: true })
			: undefined;
	const confirmSelectedTasks = () =>
		taskCandidateResult?.action && selectedTaskIndexes.length
			? actions.run(taskCandidateResult.action, 'confirm', applyStatus, {
					taskIndexes: selectedTaskIndexes
				})
			: undefined;
	const cancelSelectedTasks = () =>
		taskCandidateResult?.action
			? actions.run(taskCandidateResult.action, 'cancel', applyStatus)
			: undefined;
	const updateAssistantTask = async (task: AssistantTask, completed: boolean) => {
		const version = request.version;
		try {
			await request.request({
				method: 'patch',
				url: `/assistant/tasks/${task.id}`,
				data: { completed }
			});
			await refresh();
		} catch {
			if (request.isCurrent(version)) showMessage('error', 'Unable to update task');
		}
	};
	const reset = useCallback(() => {
		setTaskCandidateLoading(false);
		setTaskLoading(false);
	}, []);
	const selectTaskRoom = (room: string) => {
		reset();
		setSelectedTaskRoom(room);
		setTaskCandidateResult(null);
		setTaskActionStatus(null);
		setSelectedTaskIndexes([]);
	};
	return {
		assistantTasks,
		taskLoading,
		selectedTaskRoom,
		taskCandidateResult,
		taskCandidateLoading,
		selectedTaskIndexes,
		taskActionStatus,
		generateTaskCandidates,
		checkOrRetryTaskAction,
		confirmSelectedTasks,
		cancelSelectedTasks,
		updateAssistantTask,
		selectTaskRoom,
		selectTaskIndexes: setSelectedTaskIndexes,
		refresh,
		reset
	};
}
