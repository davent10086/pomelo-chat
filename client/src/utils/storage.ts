import { safeParse } from './safe-parse';

export const sessionStorageKey = 'pomelo-chat.';

interface ISessionStorage<T> {
	key: string;
	defaultValue: T;
}

/**
 * 重新封装的 sessionStorage（类型安全）
 * M3: 改名为 TypedStorage 避免遮蔽全局 Storage 接口
 * getItem 直接返回泛型 T，调用方无需 JSON.parse
 */
export class TypedStorage<T> implements ISessionStorage<T> {
	key: string;
	defaultValue: T;

	constructor(key: string, defaultValue: T) {
		this.key = sessionStorageKey + key;
		this.defaultValue = defaultValue;
	}

	setItem(value: T) {
		sessionStorage.setItem(this.key, JSON.stringify(value));
	}

	getItem(): T {
		const value = sessionStorage.getItem(this.key);
		return safeParse<T>(value, this.defaultValue);
	}

	removeItem() {
		sessionStorage.removeItem(this.key);
	}
}

/**
 * 管理 token：返回纯 token 字符串
 */
export const tokenStorage = new TypedStorage<string>('authToken', '');

/**
 * 管理用户信息：直接返回用户对象（无需调用方 JSON.parse）
 * M3: 类型修正为 IUserShape，消除调用方重复 parse
 */
export interface IUserInfo {
	id: number;
	avatar: string;
	username: string;
	name: string;
	phone: string;
	signature: string;
	created_at: string;
	[key: string]: unknown;
}
export const userStorage = new TypedStorage<IUserInfo>('userInfo', {
	id: 0,
	avatar: '',
	username: '',
	name: '',
	phone: '',
	signature: '',
	created_at: ''
});

/**
 * 获取 Authorization 头值（带 Bearer 前缀，符合 JWT 规范）
 * H12: 统一通过 tokenStorage 获取，使用 Bearer 前缀
 */
export const getAuthHeader = (): string => {
	const token = tokenStorage.getItem();
	return token ? `Bearer ${token}` : '';
};

/** 只清除当前项目所属的本地存储 */
export const clearSessionStorage = () => {
	for (const key in sessionStorage) {
		if (key.includes(sessionStorageKey)) {
			sessionStorage.removeItem(key);
		}
	}
};
