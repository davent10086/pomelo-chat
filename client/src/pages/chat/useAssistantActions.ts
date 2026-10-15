import { useCallback, useRef, useState } from 'react';
import type { ActionStatus, AgentAction } from '@/hooks/useAiAssistant';
import type useShowMessage from '@/hooks/useShowMessage';
import type { RequestScope } from '@/utils/request-scope';

type Action = Pick<AgentAction, 'confirmationId' | 'type'>;
type Operation = 'confirm' | 'query' | 'cancel';

/** A failed write is queried without silently resubmitting it. Retry is explicit. */
export function useAssistantActions(
	request: RequestScope,
	showMessage: ReturnType<typeof useShowMessage>
) {
	const [pendingActionId, setPendingActionId] = useState<string>();
	const inFlight = useRef(new Set<string>());
	const status = async (confirmationId: string) =>
		(await request.get<ActionStatus>(`/assistant/actions/${confirmationId}`)).data.data;
	const confirm = async (confirmationId: string, taskIndexes?: number[]) =>
		(
			await request.post<{ confirmationId: string; taskIndexes?: number[] }, ActionStatus>(
				'/assistant/actions/confirm',
				{ confirmationId, ...(taskIndexes ? { taskIndexes } : {}) }
			)
		).data.data;
	const run = async (
		action: Action,
		operation: Operation,
		apply: (status: ActionStatus) => Promise<void> | void,
		options: { taskIndexes?: number[]; retry?: boolean; success?: string; error?: string } = {}
	) => {
		const id = action.confirmationId;
		if (!id) return;
		const version = request.version;
		const key = `${version}:${id}`;
		if (inFlight.current.has(key)) return;
		inFlight.current.add(key);
		setPendingActionId(id);
		try {
			let result: ActionStatus;
			if (operation === 'confirm') result = await confirm(id, options.taskIndexes);
			else if (operation === 'cancel') {
				await request.post('/assistant/actions/cancel', { confirmationId: id });
				result = { confirmationId: id, type: action.type, status: 'cancelled' };
			} else {
				result = await status(id);
				if (options.retry && result.retryable) result = await confirm(id);
			}
			if (!request.isCurrent(version)) return;
			await apply(result);
			if (
				request.isCurrent(version) &&
				options.success &&
				(result.status === 'completed' || result.status === 'cancelled')
			)
				showMessage('success', options.success);
			return result;
		} catch {
			if (!request.isCurrent(version)) return;
			showMessage('error', options.error || '结果尚不确定，请查询操作状态');
			if (operation !== 'query') {
				try {
					const result = await status(id);
					if (request.isCurrent(version)) {
						await apply(result);
						return result;
					}
				} catch {
					/* Retain the card until its authoritative status can be retrieved. */
				}
			}
		} finally {
			inFlight.current.delete(key);
			if (request.isCurrent(version))
				setPendingActionId(previous => (previous === id ? undefined : previous));
		}
	};
	const reset = useCallback(() => setPendingActionId(undefined), []);
	return { pendingActionId, run, reset };
}

export type AssistantActions = ReturnType<typeof useAssistantActions>;
