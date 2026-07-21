import {
	executePomeloTool,
	type PomeloToolContext
} from './tools/pomelo-tools';

export interface AgentContext {
	currentChatType?: 'private' | 'group' | 'assistant';
	currentReceiverId?: number;
	recentMessagesText?: string;
	memoryEnabled?: boolean;
}

export interface AgentStep {
	agent: string;
	role: 'coordinator' | 'context' | 'todo' | 'reply';
	status: 'planned' | 'success' | 'skipped' | 'error';
	detail?: string;
	tools?: string[];
	durationMs?: number;
}

export interface AgentPlan {
	agentTrace: string[];
	agentSteps: AgentStep[];
	observations: Record<string, unknown>;
	preToolTrace: Array<{ tool: string; status: 'success' | 'error' }>;
	intent: 'chat' | 'context' | 'todo' | 'reply' | 'mixed';
}

export interface AgentEvent {
	type: 'agent_started' | 'agent_completed' | 'tool_started' | 'tool_completed';
	agent?: string;
	tool?: string;
	status?: 'success' | 'error';
	detail?: string;
	durationMs?: number;
}

const hasPattern = (text: string, pattern: RegExp): boolean => pattern.test(text);

export const classifyIntent = (input: string, room?: string): AgentPlan['intent'] => {
	const text = input.trim().toLowerCase();
	const wantsContext = Boolean(room) || hasPattern(text, /(summary|summarize|context|history|transcript|总结|归纳|概括|聊天记录|上下文)/i);
	const wantsTodo = hasPattern(text, /(todo|task|remind|follow.?up|待办|提醒|任务|需要|安排|截止|负责人)/i);
	const wantsReply = hasPattern(text, /(reply|draft|respond|answer|message|回复|回话|草稿|怎么说|建议|措辞|回复他)/i);
	const count = [wantsContext, wantsTodo, wantsReply].filter(Boolean).length;
	if (count > 1) return 'mixed';
	if (wantsContext) return 'context';
	if (wantsTodo) return 'todo';
	if (wantsReply) return 'reply';
	return 'chat';
};

export const chooseAgents = (input: string, room?: string): AgentStep[] => {
	const steps: AgentStep[] = [
		{
			agent: 'coordinator_agent',
			role: 'coordinator',
			status: 'planned',
			detail: 'Route the request and merge specialist results.'
		}
	];

	const intent = classifyIntent(input, room);
	if (room || intent === 'context' || intent === 'mixed') {
		steps.push({
			agent: 'chat_context_agent',
			role: 'context',
			status: 'planned',
			detail: 'Collect visible chat context for this request.',
			tools: ['get_recent_messages']
		});
	}
	if (intent === 'todo' || intent === 'mixed') {
		steps.push({
			agent: 'todo_agent',
			role: 'todo',
			status: 'planned',
			detail: 'Extract task and reminder suggestions.',
			tools: ['extract_todos']
		});
	}
	if (intent === 'reply' || intent === 'mixed') {
		steps.push({
			agent: 'reply_agent',
			role: 'reply',
			status: 'planned',
			detail: 'Prepare reply suggestions or a draft message.',
			tools: ['suggest_replies']
		});
	}

	return steps;
};

const updateStep = (
	steps: AgentStep[],
	agent: string,
	status: AgentStep['status'],
	detail: string
): void => {
	const step = steps.find(item => item.agent === agent);
	if (step) {
		step.status = status;
		step.detail = detail;
	}
};

export const runAgentOrchestrator = async ({
	userId,
	input,
	room,
	context,
	onEvent
}: {
	userId: number;
	input: string;
	room?: string;
	context?: AgentContext;
	onEvent?: (event: AgentEvent) => void;
}): Promise<AgentPlan> => {
	const toolContext: PomeloToolContext = { userId, currentRoom: room };
	const steps = chooseAgents(input, room);
	const observations: Record<string, unknown> = {};
	const preToolTrace: AgentPlan['preToolTrace'] = [];
	const contextText = [context?.recentMessagesText, input].filter(Boolean).join('\n');
	const coordinatorStartedAt = Date.now();
	onEvent?.({ type: 'agent_started', agent: 'coordinator_agent' });

	const nodeJobs: Array<Promise<void>> = [];
	const runNode = (agent: string, tool: string, args: Record<string, unknown>, key: string, detail: (result: Record<string, unknown>) => string) => {
		const startedAt = Date.now();
		onEvent?.({ type: 'agent_started', agent });
		onEvent?.({ type: 'tool_started', agent, tool });
		nodeJobs.push(
			executePomeloTool(toolContext, { name: tool, args })
				.then(result => {
					const nodeDetail = detail(result);
					const durationMs = Date.now() - startedAt;
					observations[key] = result;
					preToolTrace.push({ tool, status: 'success' });
					updateStep(steps, agent, 'success', nodeDetail);
					const step = steps.find(item => item.agent === agent);
					if (step) step.durationMs = durationMs;
					onEvent?.({ type: 'tool_completed', agent, tool, status: 'success', detail: nodeDetail, durationMs });
					onEvent?.({ type: 'agent_completed', agent, status: 'success', detail: nodeDetail, durationMs });
				})
				.catch(() => {
					const durationMs = Date.now() - startedAt;
					preToolTrace.push({ tool, status: 'error' });
					updateStep(steps, agent, 'error', `Could not execute ${tool}.`);
					const step = steps.find(item => item.agent === agent);
					if (step) step.durationMs = durationMs;
					onEvent?.({ type: 'tool_completed', agent, tool, status: 'error', detail: `Could not execute ${tool}.`, durationMs });
					onEvent?.({ type: 'agent_completed', agent, status: 'error', detail: `Could not execute ${tool}.`, durationMs });
				})
		);
	};

	if (steps.some(item => item.agent === 'chat_context_agent')) {
		if (room) {
			runNode('chat_context_agent', 'get_recent_messages', { room, limit: 20 }, 'chatContext', result => {
				const count = Array.isArray(result.messages) ? result.messages.length : 0;
				return `Loaded ${count} visible recent messages.`;
			});
		} else {
			updateStep(steps, 'chat_context_agent', 'skipped', 'No room was provided; using request context only.');
		}
	}
	if (steps.some(item => item.agent === 'todo_agent')) {
		runNode('todo_agent', 'extract_todos', { text: contextText }, 'todoHints', result => {
			const count = Array.isArray(result.todos) ? result.todos.length : 0;
			return `Found ${count} todo-like lines.`;
		});
	}
	if (steps.some(item => item.agent === 'reply_agent')) {
		runNode('reply_agent', 'suggest_replies', { text: contextText, count: 3 }, 'replyHints', result => {
			const count = Array.isArray(result.suggestions) ? result.suggestions.length : 0;
			return `Prepared ${count} context-aware reply hints.`;
		});
	}
	await Promise.all(nodeJobs);

	updateStep(steps, 'coordinator_agent', 'success', 'Specialist planning completed.');
	const coordinatorDurationMs = Date.now() - coordinatorStartedAt;
	const coordinatorStep = steps.find(item => item.agent === 'coordinator_agent');
	if (coordinatorStep) coordinatorStep.durationMs = coordinatorDurationMs;
	onEvent?.({ type: 'agent_completed', agent: 'coordinator_agent', status: 'success', detail: 'Specialist planning completed.', durationMs: coordinatorDurationMs });

	return {
		agentTrace: steps.map(item => item.agent),
		agentSteps: steps,
		observations,
		preToolTrace,
		intent: classifyIntent(input, room)
	};
};
