import { Modal } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentAction } from '@/hooks/useAiAssistant';
import type useShowMessage from '@/hooks/useShowMessage';
import type { RequestScope } from '@/utils/request-scope';
import type { AssistantMemoryItem } from './type';
import type { AssistantActions } from './useAssistantActions';

export function useAssistantMemory(
	userId: number,
	request: RequestScope,
	actions: AssistantActions,
	showMessage: ReturnType<typeof useShowMessage>
) {
	const [memoryEnabled, setMemoryEnabled] = useState(() => {
		try {
			return localStorage.getItem('AI_MEMORY_ENABLED') !== 'false';
		} catch {
			return true;
		}
	});
	const [memoryModalOpen, setMemoryModalOpen] = useState(false);
	const [memoryList, setMemoryList] = useState<AssistantMemoryItem[]>([]);
	const [memoryLoading, setMemoryLoading] = useState(false);
	const dialogs = useRef(new Set<ReturnType<typeof Modal.confirm>>());
	const closeDialogs = useCallback(() => {
		for (const dialog of dialogs.current) dialog.destroy();
		dialogs.current.clear();
	}, []);
	useEffect(() => closeDialogs, [closeDialogs, userId]);
	const callTool = async <T>(name: string, args: Record<string, unknown>) =>
		(
			await request.post<{ name: string; args: Record<string, unknown> }, { result: T }>(
				'/assistant/agent/tools/call',
				{ name, args }
			)
		).data.data.result;
	const refresh = async () => {
		const version = request.version;
		setMemoryLoading(true);
		try {
			const result = await callTool<{ memories: AssistantMemoryItem[] }>('search_memory', {
				query: '',
				limit: 20
			});
			setMemoryList(result.memories || []);
		} catch {
			if (request.isCurrent(version)) showMessage('error', 'Unable to load memories');
		} finally {
			if (request.isCurrent(version)) setMemoryLoading(false);
		}
	};
	const openMemoryManager = async () => {
		setMemoryModalOpen(true);
		await refresh();
	};
	const handleMemoryEnabledChange = (checked: boolean) => {
		setMemoryEnabled(checked);
		try {
			localStorage.setItem('AI_MEMORY_ENABLED', String(checked));
		} catch {
			/* Keep the current session setting. */
		}
	};
	const deleteMemory = async (item: AssistantMemoryItem) => {
		const version = request.version;
		try {
			const action = await callTool<AgentAction>('forget_memory', { id: item.id });
			if (!action.confirmationId) throw new Error('Missing confirmation id');
			const dialog = Modal.confirm({
				title: '确认删除这条记忆？',
				content: String(action.payload.content || item.content),
				okText: '删除',
				okButtonProps: { danger: true },
				cancelText: '取消',
				afterClose: () => dialogs.current.delete(dialog),
				onOk: async () => {
					if (!request.isCurrent(version)) return;
					const result = await actions.run(
						action,
						'confirm',
						async status => {
							if (status.status === 'completed') await refresh();
						},
						{ success: 'Memory deleted', error: 'Unable to delete memory' }
					);
					if (request.isCurrent(version) && result?.status !== 'completed')
						throw new Error('Memory deletion not completed');
				},
				onCancel: () => {
					if (request.isCurrent(version)) void actions.run(action, 'cancel', () => undefined);
				}
			});
			dialogs.current.add(dialog);
		} catch {
			if (request.isCurrent(version)) showMessage('error', 'Unable to delete memory');
		}
	};
	const reset = useCallback(
		(close = true) => {
			setMemoryLoading(false);
			if (close) {
				closeDialogs();
				setMemoryModalOpen(false);
			}
		},
		[closeDialogs]
	);
	return {
		memoryEnabled,
		memoryModalOpen,
		memoryList,
		memoryLoading,
		openMemoryManager,
		handleMemoryEnabledChange,
		deleteMemory,
		closeMemoryManager: () => setMemoryModalOpen(false),
		refresh,
		reset
	};
}
