/**
 * 接口参数类型定义
 */
// 获取好友列表接口参数类型
export interface IGroupMemberParams {
	/** 群组ID */
	groupId: number;
	/** 房间号 */
	room: string;
}
// 获取群聊成员列表接口返回数据类型
export interface IGroupMember {
	/** 用户ID */
	user_id: number;
	/** 用户头像 */
	avatar: string;
	/** 用户名 */
	username: string;
	/** 用户姓名 */
	name: string;
	/** 用户昵称 */
	nickname: string;
	/** 创建时间 */
	created_at: string;
	/** 最后消息时间 */
	lastMessageTime: string;
}

/**
 * 组件中用到的其它类型定义
 */
// 消息类型目前分为 text(文本),image(图片),video(视频),file(文件) —— 在 client\src\components\ChatContainer\type.ts 中也被引用
export type MessageType = 'text' | 'image' | 'video' | 'file'| 'default';
// 发送消息的类型 —— 在 client\src\pages\chat\index.tsx 中也被引用
export interface ISendMessage {
	/** 发送者ID */
	sender_id: number;
	/** 接收者ID */
	receiver_id: number;
	/** 消息类型 */
	type: MessageType;
	/** 消息内容 */
	content: string | number[];
	/** 发送者头像 */
	avatar: string;
	/** 文件大小(可选) */
	fileSize?: number;
}
// 左侧消息列表项类型 —— 在 client\src\pages\chat\index.tsx、client\src\pages\chat\api.ts 中也被引用
export interface IMessageListItem {
	/** 好友 id / 群聊 id */
	receiver_id: number;
	/** 接受者备注 / 群聊名称 */
	name: string;
	/** 接受者用户名，有这字段时说明是私聊，否则是群聊 */
	receiver_username?: string;
	/** 房间号 */
	room: string;
	/** 发送时间 */
	updated_at: Date;
	/** 未读消息数 */
	unreadCount: number;
	/** 最后一条消息 */
	lastMessage: string;
	/** 消息类型 */
	type: string;
	/** 接受者头像 / 群聊头像 */
	avatar: string;
}
// 给聊天输入工具组件传递的参数类型
export interface IChatToolProps {
	/** 当前选中的对话信息 */
	curChatInfo: IMessageListItem;
	/** 发送消息的回调函数 */
	sendMessage: (message: ISendMessage) => void;
}