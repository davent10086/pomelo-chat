import { better_chat } from '../../../infrastructure/redis';

export type ToolErrorCode =
	| 'UNKNOWN_TOOL'
	| 'INVALID_ARGUMENTS'
	| 'CONFIRMATION_REQUIRED'
	| 'TARGET_UNAVAILABLE'
	| 'RATE_LIMITED'
	| 'EXECUTION_FAILED';

export class ToolExecutionError extends Error {
	constructor(
		public readonly code: ToolErrorCode,
		message: string
	) {
		super(message);
		this.name = 'ToolExecutionError';
	}
}

export const toolErrorResult = (error: unknown) => ({
	isError: true as const,
	error: {
		code: error instanceof ToolExecutionError ? error.code : 'EXECUTION_FAILED',
		message:
			error instanceof ToolExecutionError
				? error.message
				: 'Tool execution failed. Please retry later.'
	}
});

// A separate tool budget permits several tool steps per Agent request. The shared
// atomic window covers Agent, HTTP and stdio calls, including confirmed writes.
const TOOL_RATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return count
`;

export const assertToolRateLimit = async (userId: number): Promise<void> => {
	if (!Number.isSafeInteger(userId) || userId <= 0)
		throw new ToolExecutionError('INVALID_ARGUMENTS', 'A valid user id is required.');
	let count: number;
	try {
		count = Number(await better_chat.eval(TOOL_RATE_SCRIPT, 1, `ai_tool_rate:${userId}`));
	} catch {
		throw new ToolExecutionError('EXECUTION_FAILED', 'Tool service is temporarily unavailable.');
	}
	if (!Number.isSafeInteger(count) || count < 1 || count > 120)
		throw new ToolExecutionError(
			'RATE_LIMITED',
			'Tool call limit reached. Retry after one minute.'
		);
};
