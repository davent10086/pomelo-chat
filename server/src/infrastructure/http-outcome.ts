import type { Response } from 'express';
import type { Outcome } from '../shared/outcome';
import { RespData } from './http-response';
export const respond = (res: Response, result: Outcome): void =>
	RespData(res, result.data, result.code);
