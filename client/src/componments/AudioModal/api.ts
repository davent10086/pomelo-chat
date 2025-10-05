import  Request  from "@/utils/request";

/**
 * 获取房间成员列表
 * @param room 房间标识符
 * @returns 返回房间内所有成员的字符串数组
 */
export const getRoomMembers = async (room:string) =>{
    // 发送GET请求获取房间成员数据
    const res = await Request.get<string[]>(`rtc/room_members/?room=${room}`);
    // 返回响应数据中的成员列表
    return res.data;
}