import type { JwtPayload } from 'jsonwebtoken';

// 扩展 Express Request，挂载鉴权后的用户信息
declare module 'express' {
	interface Request {
		user?: JwtPayload & {
			id: number | string;
			username: string;
			name?: string;
			avatar?: string;
			phone?: string;
		};
	}
}

export {};
