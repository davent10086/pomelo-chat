// 优先使用环境变量，其次根据当前页面所在主机动态拼接（便于局域网调试）
// Vite 注入的环境变量类型声明（避免使用 any）
interface ViteEnv {
	VITE_API_BASE?: string;
	VITE_WS_BASE?: string;
	VITE_SERVER_URL?: string;
}
const viteEnv = ((import.meta as unknown) as { env: ViteEnv }).env || ({} as ViteEnv);
const ENV_API = viteEnv.VITE_API_BASE;
const ENV_WS = viteEnv.VITE_WS_BASE;
const ENV_SERVER = viteEnv.VITE_SERVER_URL;

const DEFAULT_PORT = 3000;
const isBrowser = typeof window !== 'undefined' && !!window.location;
const proto = isBrowser ? window.location.protocol : 'http:';
const host = isBrowser ? window.location.hostname : '127.0.0.1';
const wsProto = proto === 'https:' ? 'wss:' : 'ws:';

// 服务端接口的 baseURL
export const apiBaseURL = ENV_API || `${proto}//${host}:${DEFAULT_PORT}/api/chat/v1`;

// 建立 websocket 的 baseURL
export const wsBaseURL = ENV_WS || `${wsProto}//${host}:${DEFAULT_PORT}/api/chat/v1`;

// 服务器的地址 URL
export const serverURL = ENV_SERVER || `${proto}//${host}:${DEFAULT_PORT}`;
