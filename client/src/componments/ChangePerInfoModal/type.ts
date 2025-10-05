/**
 * 接口参数类型定义
 */

/**
 * 修改密码接口参数类型
 * @interface IChangePwdParams
 * @property {string} username - 用户名
 * @property {string} phone - 手机号码
 * @property {string} password - 新密码
 * @property {string} confirmPassword - 确认新密码
 */
export interface IChangePwdParams {
	username: string;
	phone: string;
	password: string;
	confirmPassword: string;
}

/**
 * 用户信息接口返回数据类型
 * @interface IUserInfo
 * @property {number} id - 用户ID
 * @property {string} avatar - 用户头像URL
 * @property {string} username - 用户名
 * @property {string} phone - 手机号码
 * @property {string} email - 邮箱地址
 * @property {string} name - 用户昵称
 * @property {string} created_at - 创建时间
 * @property {string} signature - 个性签名
 */
export interface IUserInfo{
	id: number;
	avatar: string;
	username: string;
	phone: string;
	email: string;
	name: string;
	created_at: string;
	signature: string;
}

/**
 * 登录接口返回数据类型
 * @interface ILoginResponseData
 * @property {string} token - 用户认证令牌
 * @property {IUserInfo} user - 用户信息
 */
export interface ILoginResponseData{
	token: string;
	info: IUserInfo;
}

/**
 * 组件中用到的其它类型定义
 */

/**
 * 修改密码弹窗组件参数类型
 * @interface IChangePwdModalProps
 * @property {boolean} openmodal - 弹窗显示状态
 * @property {function} handleModal - 控制弹窗显示/隐藏的回调函数
 */
export interface IChangePwdModalProps {
	openmodal: boolean;
	handleModal: (visible: boolean) => void;
}

/**
 * 修改密码表单数据类型
 * @interface IChangePwdForm
 * @property {string} username - 用户名
 * @property {string} phone - 手机号码
 * @property {string} password - 新密码
 * @property {string} confirm - 确认新密码
 */
export interface IChangePwdForm {
	username: string;
	phone: string;
	password: string;
	confirm: string;
}