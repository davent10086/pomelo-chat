/**
 * 接口参数类型定义
 */
// 修改信息接口参数类型
export interface IChangePerInfoParams {
	username: string;
	name: string;
	phone: string;
	avatar: string;
	signature: string;
}
// 用户信息接口 —— 统一从 @/utils/storage 复用，避免类型重复定义
export type { IUserInfo } from '@/utils/storage';
// 修改信息接口返回的 data 类型 —— 在client\src\pages\login\index.tsx中也被引用到
export interface ILoginResponseData {
	token: string;
	info: import('@/utils/storage').IUserInfo;
}

/**
 * 组件中用到的其它类型定义
 */
// 给修改个人信息组件传递的参数类型
export interface IChangePerInfoModalProps {
	openmodal: boolean;
	handleModal: (visible: boolean) => void;
}
// 修改用户信息表单类型
export interface IChangePerInfoForm {
	avatar: string;
	name: string;
	phone: string;
	signature: string;
}
