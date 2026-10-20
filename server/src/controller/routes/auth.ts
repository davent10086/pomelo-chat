import { initUserNotification } from '../../modules/realtime/notification-socket';
import { Router } from 'express';
import { identityHttp as auth } from '../../composition';
import { authenticateToken } from '../../modules/identity/middleware';
import { createRateLimiter } from '../../infrastructure/rate-limit';
import { createHash } from 'crypto';
import { boundedInteger } from '../../shared/validation';

const router = Router();
const authIpLimit = createRateLimiter({ name: 'auth-ip', windowSeconds: 60, max: boundedInteger('AUTH_IP_RATE_LIMIT_MAX', 30) });
const authAccountLimit = createRateLimiter({ name: 'auth-account', windowSeconds: 300, max: boundedInteger('AUTH_ACCOUNT_RATE_LIMIT_MAX', 10),
	key: req => createHash('sha256').update(String(req.body?.username || '').trim().toLowerCase()).digest('hex') });

/**
 * 认证相关路由配置
 * 定义了登录、注册、密码重置等认证相关的API端点
 * @returns 配置好的Express路由器对象
 */
export default () => {
	// 用户登录接口
	router.post('/login', authIpLimit, authAccountLimit, auth.login);
	// 用户登出接口
	router.post('/logout', authenticateToken, auth.logout);
	// 用户注册接口
	router.post('/register', authIpLimit, authAccountLimit, auth.register);
	// 忘记密码接口
	router.post('/forget_password', authenticateToken, auth.forgetPassword);
	// 更新用户信息接口，需要验证token后才能访问
	router.post('/update_info', authenticateToken, auth.updateInfo);
	// WebSocket用户通知频道，用于实时消息推送
	router.ws('/user_channel', initUserNotification);
	return router;
};
