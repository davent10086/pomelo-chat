import { IRegisterParams, IRegisterResponseData } from './type';

import Request from '@/utils/request';

/**
 * 用户注册API函数
 * @param data - 注册参数对象，包含用户名、密码等注册所需信息
 * @returns 返回注册响应数据，通常包含注册结果相关信息
 */
export const handleRegister = async (data: IRegisterParams) => {
	const res = await Request.post<IRegisterParams, IRegisterResponseData>(`/auth/register`, data);
	return res.data;
};