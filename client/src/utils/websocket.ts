/**
 * 支持指数退避策略的 WebSocket 自动重连封装类
 *
 * 使用方式：
 *   const ws = new ReconnectingWebSocket(url);
 *   ws.onMessage = (e) => { ... };
 *   ws.connect();
 *   // 需要关闭时调用 ws.close()，不会自动重连
 */

export interface ReconnectingWebSocketOptions {
	/** 初始重连延迟（ms），默认 1000 */
	initialDelay?: number;
	/** 最大重连延迟（ms），默认 30000 */
	maxDelay?: number;
	/** 每次重连延迟倍增因子，默认 2 */
	backoffFactor?: number;
	/** 最大重连次数，默认 Infinity */
	maxRetries?: number;
	/** WebSocket 连接超时时间（ms），默认 10000 */
	connectTimeout?: number;
}

export class ReconnectingWebSocket {
	private url: string;
	private protocols?: string | string[];
	private ws: WebSocket | null = null;
	private options: Required<ReconnectingWebSocketOptions>;

	private retryCount = 0;
	private currentDelay: number;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private connectTimer: ReturnType<typeof setTimeout> | null = null;
	private manualClose = false;
	private destroyed = false;
	private _isReconnecting = false;

	// 对外暴露的回调，与原生 WebSocket 事件一一对应
	public onOpen: ((e: Event) => void) | null = null;
	public onMessage: ((e: MessageEvent) => void) | null = null;
	public onError: ((e: Event) => void) | null = null;
	public onClose: ((e: CloseEvent) => void) | null = null;
	/** 每次重连时触发，参数为当前重连次数 */
	public onReconnecting: ((retryCount: number) => void) | null = null;
	/** 重连次数耗尽时触发 */
	public onMaxRetriesReached: (() => void) | null = null;

	constructor(url: string, options?: ReconnectingWebSocketOptions, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
		this.options = {
			initialDelay: options?.initialDelay ?? 1000,
			maxDelay: options?.maxDelay ?? 30000,
			backoffFactor: options?.backoffFactor ?? 2,
			maxRetries: options?.maxRetries ?? Infinity,
			connectTimeout: options?.connectTimeout ?? 10000
		};
		this.currentDelay = this.options.initialDelay;
	}

	/** 建立连接 */
	public connect(): void {
		if (this.destroyed) return;
		this.manualClose = false;
		this.createConnection();
	}

	/** 发送消息，底层透传给原生 WebSocket.send() */
	public send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(data);
		} else {
			console.warn('[ReconnectingWebSocket] 连接未就绪，消息丢弃');
		}
	}

	/** 主动关闭连接，不会触发自动重连 */
	public close(code?: number, reason?: string): void {
		this.manualClose = true;
		this.cleanup();
		this.ws?.close(code, reason);
		this.ws = null;
	}

	/** 销毁实例，释放所有资源 */
	public destroy(): void {
		this.destroyed = true;
		this.manualClose = true;
		this.cleanup();
		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onerror = null;
			this.ws.onclose = null;
			this.ws.close();
			this.ws = null;
		}
	}

	/** 获取当前连接状态 */
	public get readyState(): number {
		return this.ws?.readyState ?? WebSocket.CLOSED;
	}

	/** 是否正在重连中 */
	public get isReconnecting(): boolean {
		return this._isReconnecting;
	}

	// ---- 内部方法 ----

	private createConnection(): void {
		this.cleanupTimers();

		this.ws = this.protocols ? new WebSocket(this.url, this.protocols) : new WebSocket(this.url);
		this.startConnectTimeout();

		this.ws.onopen = (e: Event) => {
			this.clearConnectTimeout();
			this._isReconnecting = false;
			this.retryCount = 0;
			this.currentDelay = this.options.initialDelay;
			this.onOpen?.(e);
		};

		this.ws.onmessage = (e: MessageEvent) => {
			this.onMessage?.(e);
		};

		this.ws.onerror = (e: Event) => {
			this.clearConnectTimeout();
			this.onError?.(e);
		};

		this.ws.onclose = (e: CloseEvent) => {
			this.clearConnectTimeout();
			this.onClose?.(e);
			this.scheduleReconnect();
		};
	}

	private scheduleReconnect(): void {
		if (this.manualClose || this.destroyed) return;
		if (this.retryCount >= this.options.maxRetries) {
			console.warn('[ReconnectingWebSocket] 已达最大重连次数，停止重连');
			this._isReconnecting = false;
			this.onMaxRetriesReached?.();
			return;
		}

		this.retryCount++;
		this._isReconnecting = true;
		const delay = this.currentDelay;
		console.log(
			`[ReconnectingWebSocket] 第 ${this.retryCount} 次重连，延迟 ${delay}ms`
		);
		this.onReconnecting?.(this.retryCount);

		this.reconnectTimer = setTimeout(() => {
			this.createConnection();
			// 指数退避：每次翻倍，不超过 maxDelay
			this.currentDelay = Math.min(
				this.currentDelay * this.options.backoffFactor,
				this.options.maxDelay
			);
		}, delay);
	}

	private startConnectTimeout(): void {
		this.connectTimer = setTimeout(() => {
			if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
				console.warn('[ReconnectingWebSocket] 连接超时');
				this.ws.close();
			}
		}, this.options.connectTimeout);
	}

	private clearConnectTimeout(): void {
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
	}

	private cleanupTimers(): void {
		this.clearConnectTimeout();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private cleanup(): void {
		this.cleanupTimers();
	}
}

export default ReconnectingWebSocket;
