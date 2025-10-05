/**
 * 接口参数类型定义
 */
// 分组好友列表数据类型 —— 在client\src\pages\address-book\index.tsx、client\src\pages\address-book\api.ts中也被引用
export interface IFriendGroupItem {
	/** @param name 分组名称 */
	name: string;
	/** @param online_counts 在线人数统计 */
	online_counts: number;
	/** @param friend 分组中的好友列表 */
	friend: IFriendItem[];
}
// 单个好友数据类型
export interface IFriendItem {
	/** @param id 好友ID */
	id: number;
	/** @param user_id 用户ID */
	user_id: number;
	/** @param username 用户名 */
	username: string;
	/** @param avatar 头像URL */
	avatar: string;
	/** @param online_status 在线状态 */
	online_status: 'online' | 'offline';
	/** @param remark 备注名 */
	remark: string;
	/** @param group_id 所属分组ID */
	group_id: number;
	/** @param room 房间信息 */
	room: null;
	/** @param unread_msg_count 未读消息数量 */
	unread_msg_count: number;
	/** @param created_at 创建时间 */
	created_at: string;
	/** @param updated_at 更新时间 */
	updated_at: string;
}
// 创建群聊时成员数据类型
export interface IGroupMemberItem {
	/** @param user_id 用户ID */
	user_id: number;
	/** @param username 用户名 */
	username: string;
	/** @param avatar 头像URL */
	avatar: string;
}
// 创建群聊时传递的参数
export interface ICreateGroupParams {
	/** @param name 群聊名称 */
	name: string;
	/** @param announcement 群公告 */
	announcement: string;
	/** @param avatar 群头像URL */
	avatar: string;
	/** @param members 群成员列表 */
	members: IGroupMemberItem[];
}
// 邀请新的好友进入群聊时传递的参数
export interface InviteFriendsParams {
	/** @param groupId 群组ID */
	groupId: number;
	/** @param invitationList 邀请用户列表 */
	invitationList: IGroupMemberItem[];
}

/**
 * 组件中用到的其它参数类型定义
 */
// 群聊成员信息（右边展示）
interface IGroupChatMemberItem {
	/** @param avatar 头像URL */
	avatar: string;
	/** @param created_at 创建时间 */
	created_at: string;
	/** @param lastMessageTime 最后消息时间 */
	lastMessageTime: string | null;
	/** @param username 用户名 */
	username: string;
	/** @param name 群名称 */
	name: string;
	/** @param nickname 群昵称 */
	nickname: string;
	/** @param user_id 用户ID */
	user_id: number;
}
// 群聊具体信息 (右边展示)
// 在client\src\pages\address-book\index.tsx、client\src\pages\address-book\type.ts、client\src\pages\address-book\api.ts中也被引用
// 在client\src\pages\chat\index.tsx、client\src\pages\chat\type.ts中也被引用
// 在client\src\pages\container\index.tsx中也被引用
export interface IGroupChatInfo {
	/** @param announcement 群公告 */
	announcement: string;
	/** @param avatar 群头像URL */
	avatar: string;
	/** @param created_at 创建时间 */
	created_at: string;
	/** @param creator_id 创建者ID */
	creator_id: number;
	/** @param creator_username 创建者用户名 */
	creator_username: string;
	/** @param id 群ID */
	id: number;
	/** @param name 群名称 */
	name: string;
	/** @param room 房间标识 */
	room: string;
	/** @param members 群成员列表 */
	members: IGroupChatMemberItem[];
}
// 给创建群聊弹窗组件传递的参数类型
export interface ICreateGroupModal {
	/** @param openmodal 弹窗是否显示 */
	openmodal: boolean;
	/** @param handleModal 控制弹窗显示/隐藏的处理函数 */
	handleModal: (visible: boolean) => void;
	/** @param type 操作类型：创建群聊或邀请成员 */
	type: 'create' | 'invite';
	/** @param groupChatInfo 群聊信息，当type为invite时需要传递 */
	groupChatInfo?: IGroupChatInfo; // 当type为invite时，需要传递群聊信息
}
// 创建群聊表单类型
export interface ICreateGroupForm {
	/** @param groupAvatar 群头像URL */
	groupAvatar: string;
	/** @param groupName 群名称 */
	groupName: string;
	/** @param announcement 群公告 */
	announcement: string | null;
}