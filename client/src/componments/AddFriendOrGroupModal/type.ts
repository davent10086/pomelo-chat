/**
 * 接口参数类型定义
 */
// 获取好友的类型
export interface IFriendItem {
	/** 用户昵称 */
	name: string;
	/** 用户名 */
	username: string;
	/** 用户ID */
	id: number;
	/** 用户头像URL */
	avatar: string;
	/** 在线状态 */
	status: boolean;
}
// 加好友参数类型
export interface IAddFriendParams {
	/** 用户ID */
	id: number;
	/** 用户名 */
	username: string;
	/** 用户头像URL */
	avatar: string;
}
// 获取的群聊类型
export interface IGroupItem {
	/** 群聊头像URL */
	avatar: string;
	/** 群聊ID */
	group_id: number;
	/** 群聊名称 */
	name: string;
	/** 群成员数量 */
	number: number;
	/** 群聊状态 */
	status: boolean;
}
// 加入群聊参数类型
export interface IAddGroupParams {
	/** 群聊ID */
	group_id: number;
}

/**
 * 组件中用到的其它类型定义
 */
// 给添加好友或群聊弹窗组件传递的参数类型
export interface IAddFriendOrGroupModalProps {
	/** 控制弹窗显示状态 */
	openmodal: boolean;
	/** 控制弹窗显示隐藏的回调函数 */
	handleModal: (visible: boolean) => void;
}