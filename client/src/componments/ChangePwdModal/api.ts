import { IChangePwdParams } from './type';

import Request from '@/utils/request';

/**
 * 修改用户密码
 * @param data 包含修改密码所需信息的参数对象
 * @returns 返回接口响应的数据部分
 */
export const handleChange = async (data: IChangePwdParams) => {
	const res = await Request.post<IChangePwdParams>(`/auth/forget_password`, data);
	return res.data;
};