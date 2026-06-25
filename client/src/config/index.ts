// 优先使用环境变量，其次根据当前页面所在主机动态拼接（便于局域网调试）
// Vite 注入的环境变量类型声明（避免使用 any）
interface ViteEnv {
	VITE_API_BASE?: string;
	VITE_WS_BASE?: string;
	VITE_SERVER_URL?: string;
	VITE_SERVER_PORT?: string;
}

// 获取 Vite 环境变量，兼容不同环境下的访问方式
const viteEnv = ((import.meta as unknown) as { env: ViteEnv }).env || ({} as ViteEnv);

// 从环境变量中提取配置值
const ENV_API = viteEnv.VITE_API_BASE;
const ENV_WS = viteEnv.VITE_WS_BASE;
const ENV_SERVER = viteEnv.VITE_SERVER_URL;

// 默认服务端口配置（从环境变量读取，便于非 3000 端口部署）
const DEFAULT_PORT = Number(viteEnv.VITE_SERVER_PORT) || 3000;

// 判断运行环境是否为浏览器环境
const isBrowser = typeof window !== 'undefined' && !!window.location;

// 根据运行环境确定协议和主机地址
const proto = isBrowser ? window.location.protocol : 'http:';
const host = isBrowser ? window.location.hostname : '127.0.0.1';

// 确定 WebSocket 协议类型，HTTPS 对应 WSS，HTTP 对应 WS
const wsProto = proto === 'https:' ? 'wss:' : 'ws:';

// 服务端接口的 baseURL
export const apiBaseURL = ENV_API || `${proto}//${host}:${DEFAULT_PORT}/api/chat/v1`;

// 建立 websocket 的 baseURL
export const wsBaseURL = ENV_WS || `${wsProto}//${host}:${DEFAULT_PORT}/api/chat/v1`;

// 服务器的地址 URL
export const serverURL = ENV_SERVER || `${proto}//${host}:${DEFAULT_PORT}`;