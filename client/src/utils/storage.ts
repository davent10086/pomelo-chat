/**
 * 会话存储的键名前缀
 */
export const sessionStorageKey = 'pemelo-chat'

/**
 * 会话存储接口定义
 */
interface ISessionStorage<T> {
    /**
     * 存储键名
     */
    key: string;
    /**
     * 默认值
     */
    defaultValue: T;
}

/**
 * 存储类，用于操作sessionStorage
 * @template T 存储值的类型
 */
export class Storage<T> implements ISessionStorage<T> {
    /**
     * 存储键名
     */
    key: string;
    /**
     * 默认值
     */
    defaultValue: T;

    /**
     * 构造函数
     * @param key 存储键名，会自动添加前缀
     * @param defaultValue 默认值
     */
    constructor(key: string, defaultValue: T) {
        this.key = sessionStorageKey + key;
        this.defaultValue = defaultValue;
    }

    /**
     * 设置存储项
     * @param value 要存储的值
     */
    setItem(value: T) {
        sessionStorage.setItem(this.key,JSON.stringify(value));
    }

    /**
     * 获取存储项
     * @returns 存储的值或默认值
     */
    getItem(): T {
        const value = sessionStorage[this.key] &&sessionStorage.getItem(this.key)
        if (value === undefined) return this.defaultValue;
        try {
            // 尝试解析JSON格式的数据
            return value && value !== 'null' && value !== 'undefined'
                ?(JSON.parse(value) as T)
                : this.defaultValue;
        }catch{
            // 如果解析失败，直接返回原始值
            return value && value !== 'null' && value !== 'undefined'
                ?(value as unknown as T)
                : this.defaultValue;
        }
    }
    
    /**
     * 移除存储项
     */
    removeItem() {
        sessionStorage.removeItem(this.key);
    }
}

/**
 * 认证令牌存储实例
 */
export const tokenStorage = new Storage<string>('authToken', '');

/**
 * 用户信息存储实例
 */
export const userStorage = new Storage<string>('userInfo', '');

/**
 * 清除所有带有指定前缀的会话存储项
 */
export const clearSessionStorage = () => {
    for (const key in sessionStorage){
        if (key.includes(sessionStorageKey)){
            sessionStorage.removeItem(key);
        }
    }
};