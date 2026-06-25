/**
 * 安全的 JSON.parse：解析失败时返回 fallback，不抛异常
 * 用于所有外部数据入口（WebSocket 推送、storage、接口响应等）
 */
export function safeParse<T>(str: string | null | undefined, fallback: T): T {
	if (str === null || str === undefined || str === '') return fallback;
	try {
		return JSON.parse(str) as T;
	} catch {
		return fallback;
	}
}

/**
 * 安全的 JSON.parse，返回 unknown（需调用方自行类型断言/校验）
 * 解析失败返回 null
 */
export function safeParseNullable<T>(str: string | null | undefined): T | null {
	if (str === null || str === undefined || str === '') return null;
	try {
		return JSON.parse(str) as T;
	} catch {
		return null;
	}
}
