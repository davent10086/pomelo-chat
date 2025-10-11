/**
 * 接口参数类型定义
 */

/**
 * 注册接口参数类型
 * 包含用户注册所需的基本信息
 */
export interface IRegisterParams {
	username: string;
	phone: string;
	password: string;
	confirmPassword: string;
}

/**
 * 注册接口返回的 data 类型
 * 包含注册成功后服务器返回的用户信息和认证令牌
 */
export interface IRegisterResponseData {
	/** 用户认证令牌 */
	token: string;
	/** 用户详细信息 */
	info: {
		/** 用户ID */
		id: number;
		/** 用户头像URL */
		avatar: string;
		/** 用户名 */
		username: string;
		/** 用户姓名 */
		name: string;
		/** 用户手机号 */
		phone: string;
		/** 账户创建时间 */
		created_at: string;
		/** 用户个性签名 */
		signature: string;
	};
}

/**
 * 组件中用到的其它类型定义
 */

/**
 * 注册表单类型
 * 用于前端表单收集用户输入数据
 */
export interface IRegisterForm {
	username: string;
	phone: string;
	password: string;
	confirm: string;
}