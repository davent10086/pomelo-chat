import type { AxiosRequestConfig } from 'axios';
import request from './request';

/** A session's requests cannot publish results after its generation has ended. */
export class RequestScope {
	version = 0;
	private controller = new AbortController();
	private active = true;
	isCurrent(version: number) {
		return this.active && version === this.version;
	}
	invalidate() {
		this.controller.abort();
		this.controller = new AbortController();
		this.version++;
	}
	resume() {
		this.active = true;
		this.invalidate();
	}
	dispose() {
		this.active = false;
		this.invalidate();
	}
	private async run<T>(operation: (signal: AbortSignal) => Promise<T>) {
		const version = this.version;
		if (!this.isCurrent(version)) throw new DOMException('Session ended', 'AbortError');
		const response = await operation(this.controller.signal);
		if (!this.isCurrent(version)) throw new DOMException('Stale session result', 'AbortError');
		return response;
	}
	get<T = unknown>(url: string, config?: AxiosRequestConfig) {
		return this.run(signal => request.get<T>(url, { ...config, signal }));
	}
	post<TRequest = unknown, TResponse = unknown>(
		url: string,
		data?: TRequest,
		config?: AxiosRequestConfig
	) {
		return this.run(signal => request.post<TRequest, TResponse>(url, data, { ...config, signal }));
	}
	request<T = unknown>(config: AxiosRequestConfig) {
		return this.run(signal => request.request<T>({ ...config, signal }));
	}
}
