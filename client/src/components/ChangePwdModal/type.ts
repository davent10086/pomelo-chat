/**
 * 接口参数类型定义
 */
// 注册接口参数类型
export interface IChangePwdParams {
	currentPassword: string;
	password: string;
}

/**
 * 组件中用到的其它类型定义
 */
// 给修改密码弹窗组件传递的参数类型
export interface IChangePwdModalProps {
	openmodal: boolean;
	handleModal: (visible: boolean) => void;
}
// 修改密码表单类型
export interface IChangePwdForm {
	currentPassword: string;
	password: string;
	confirm: string;
}
