const express = require('express');
const router = express.Router();
const auth = require('../../service/auth/index');
const authenticate = require('../../utils/authenticate');

/**
 * 认证相关路由配置
 * 定义了登录、注册、密码重置等认证相关的API端点
 * @returns {Object} 返回配置好的Express路由器对象，包含所有认证相关路由
 */
module.exports = () => {
	// 用户登录接口，接收POST请求并调用auth服务的登录方法
	router.post('/login', auth.login);
	// 用户登出接口，接收POST请求并调用auth服务的登出方法
	router.post('/logout', auth.logout);
	// 用户注册接口，接收POST请求并调用auth服务的注册方法
	router.post('/register', auth.register);
	// 忘记密码接口，接收POST请求处理密码重置请求
	router.post('/forget_password', auth.forgetPassword);
	// 更新用户信息接口，需要验证token后才能访问
	router.post('/update_info', authenticate.authenticateToken, auth.updateInfo);
	// WebSocket用户通知频道，用于实时消息推送
	router.ws('/user_channel', auth.initUserNotification);
	return router;
};