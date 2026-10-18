import type { Response } from 'express';
import type { Outcome } from '../shared/outcome';
import { RespData } from './http-response';
export const respond = (res: Response, result: Outcome): void => {
	if (result.code === 8001) {
		const delay = Number((result.data as { retryAfterMs?: number } | null)?.retryAfterMs);
		res.setHeader(
			'Retry-After',
			String(Number.isFinite(delay) && delay > 0 ? Math.ceil(delay / 1000) : 1)
		);
	}
	RespData(res, result.data, result.code);
};
