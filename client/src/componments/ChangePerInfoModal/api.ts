import type { IChangePwdParams, ILoginResponseData } from "./type";

import Request from "../../utils/request";

export const handleChange = async (data: IChangePwdParams)=> {
  const res = await Request.post<IChangePwdParams,ILoginResponseData>('/auth/forget_password', data)
  return res.data;
};