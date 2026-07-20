import { Router } from 'express';
import * as auth from '../../service/auth';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

/**
 * 认证相关路由配置
 * 定义了登录、注册、密码重置等认证相关的API端点
 * @returns 配置好的Express路由器对象
 */
export default () => {
	// 用户登录接口
	router.post('/login', auth.login);
	// 用户登出接口
	router.post('/logout', authenticateToken, auth.logout);
	// 用户注册接口
	router.post('/register', auth.register);
	// 忘记密码接口
	router.post('/forget_password', authenticateToken, auth.forgetPassword);
	// 更新用户信息接口，需要验证token后才能访问
	router.post('/update_info', authenticateToken, auth.updateInfo);
	// WebSocket用户通知频道，用于实时消息推送
	router.ws('/user_channel', auth.initUserNotification);
	return router;
};
