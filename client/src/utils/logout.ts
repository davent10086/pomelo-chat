import { IUserInfo } from "@/componments/ChangePerInfoModal/type";
import Request from "@/utils/request";

export const handleLogout = async (data: IUserInfo) => {
    const res = await Request.post<IUserInfo>(`/auth/logout`,data);
    return res.data;
}