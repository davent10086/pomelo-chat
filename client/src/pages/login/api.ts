import { ILoginParams } from "./type";
import { ILoginResponseData } from "@/componments/ChangePerInfoModal/type";
import Result from "@/utils/request";

/**
 * 处理用户登录请求
 * @param data 登录参数，包含用户名和密码等信息
 * @returns 返回登录接口的响应数据
 */
export const handleLogin = async (data:ILoginParams) => {
    // 发送登录请求到后端接口
    const res = await Result.post<ILoginParams, ILoginResponseData>('/auth/login', data);
    return res.data;
}
