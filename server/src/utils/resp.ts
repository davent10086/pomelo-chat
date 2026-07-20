import type { Response } from 'express';
import { StatusMap, SUCCESS_CODE } from './status';

interface RespBody {
	code: number;
	data: unknown;
	message: string;
}

const respHttp = (res: Response, respCode: number, data?: unknown): void => {
	const resp: RespBody = {
		code: SUCCESS_CODE,
		data: '',
		message: 'success'
	};
	resp.code = respCode;
	resp.data = data || '';
	resp.message = StatusMap[respCode] || 'success';
	res.json(resp);
};

// 请求成功
export const RespSuccess = (res: Response): void => {
	respHttp(res, SUCCESS_CODE);
};

// 请求失败
export const RespError = (res: Response, respCode: number): void => {
	respHttp(res, respCode);
};

// 请求成功且返回数据
export const RespData = (res: Response, data: unknown, respCode?: number): void => {
	respHttp(res, respCode || SUCCESS_CODE, data);
};
