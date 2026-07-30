import axios from 'axios';

import type {
	AxiosInstance,
	AxiosRequestConfig,
	InternalAxiosRequestConfig,
	AxiosResponse,
	AxiosError
} from 'axios';

import { apiBaseURL } from '@/config';
import { tokenStorage } from '@/utils/storage';

/**
 * 统一的 API 响应格式接口定义
 */
interface ApiResponse<T> {
	code: number;
	message: string;
	data: T;
}

/**
 * 规范化的 API 错误对象（M4: 统一错误返回类型）
 */
export interface ApiError {
	status: number;
	code?: number;
	message: string;
	raw?: unknown;
}

/**
 * 封装了 Axios 请求逻辑的类
 * H12: token 头使用 Bearer 前缀，通过 tokenStorage 统一获取
 * M4: 响应拦截器错误统一返回 ApiError
 */
export class Request {
	private instance: AxiosInstance;
	// M4: 默认超时延长至 10s，文件接口可单独配置更长
	private defaultConfig: AxiosRequestConfig = { baseURL: apiBaseURL, timeout: 10000 };

	constructor(config: AxiosRequestConfig) {
		const mergedConfig = { ...this.defaultConfig, ...config };
		this.instance = axios.create(mergedConfig);

		// 请求拦截器：注入 Authorization 头（Bearer 前缀）
		this.instance.interceptors.request.use(
			(config: InternalAxiosRequestConfig) => {
				const token = tokenStorage.getItem();
				if (token) {
					config.headers.Authorization = `Bearer ${token}`;
				}
				return config;
			},
			(error: AxiosError) => {
				return Promise.reject(error);
			}
		);

		// 响应拦截器：统一错误格式为 ApiError（保留 status 供调用方判断）
		this.instance.interceptors.response.use(
			(response: AxiosResponse) => response,
			(error: AxiosError) => {
				const apiError: ApiError = {
					status: error.response?.status || 0,
					message: (error.response?.data as { message?: string })?.message || error.message || '请求失败',
					raw: error.response?.data
				};
				return Promise.reject(apiError);
			}
		);
	}

	public request<TResponse = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<TResponse>> {
		return this.instance.request<TResponse>(config);
	}

	public get<TResponse = unknown>(
		url: string,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.get(url, config);
	}

	public post<TRequest = unknown, TResponse = unknown>(
		url: string,
		data?: TRequest,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.post(url, data, config);
	}

	public put<TRequest = unknown, TResponse = unknown>(
		url: string,
		data?: TRequest,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.put(url, data, config);
	}

	public delete<TResponse = unknown>(
		url: string,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.delete(url, config);
	}
}

export default new Request({});
