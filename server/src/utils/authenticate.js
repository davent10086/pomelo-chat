const jwt = require('jsonwebtoken');
const Redis = require('ioredis');

const { CommonStatus } = require('./status');
const { RespError } = require('./resp');

// 密钥从环境变量读取，未配置时给出明确错误（不内置默认值以防误用）
const secretKey = process.env.JWT_SECRET;
if (!secretKey) {
	// eslint-disable-next-line no-console
	console.error('[auth] 警告：未配置环境变量 JWT_SECRET，JWT 功能将不可用');
}

// Redis 用于校验 token 白名单（登录时写入，登出/失效时删除）
const better_chat = new Redis();

// 校验 Bearer token 格式并提取纯 token
const extractToken = (authHeader) => {
	if (!authHeader) return null;
	// 兼容 "Bearer xxx" 与裸 token 两种格式
	if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
	return authHeader;
};

// JWT 校验中间件：校验签名 + 过期 + Redis 白名单
const authenticateToken = (req, res, next) => {
	const raw = req.headers.authorization;
	const token = extractToken(raw);
	if (!token) {
		return RespError(res, CommonStatus.TOKEN_ERR);
	}
	jwt.verify(token, secretKey, async (err, decoded) => {
		if (err) {
			return RespError(res, CommonStatus.TOKEN_ERR);
		}
		// 校验 Redis 白名单：token 必须在 Redis 中存在（实现真正的登出失效）
		try {
			const cached = await better_chat.get(`token:${decoded.username}`);
			if (cached !== token) {
				return RespError(res, CommonStatus.TOKEN_ERR);
			}
		} catch (redisErr) {
			// Redis 不可用时降级放行（避免 Redis 故障导致全站不可用），并记录日志
			// eslint-disable-next-line no-console
			console.error('[auth] Redis 校验失败，降级放行:', redisErr.message);
		}
		req.user = decoded;
		next();
	});
};

// 用于 ws 握手时同步校验 token（非中间件场景）
const verifyToken = (token) => {
	const pure = extractToken(token);
	if (!pure) return null;
	try {
		const decoded = jwt.verify(pure, secretKey);
		return decoded;
	} catch (err) {
		return null;
	}
};

module.exports = {
	authenticateToken,
	verifyToken,
	secretKey, // 仅供 auth 服务内部签发使用，不再用于外部校验
	better_chat,
	extractToken
};
