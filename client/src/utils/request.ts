/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';

import type {
	AxiosInstance,
	AxiosRequestConfig,
	InternalAxiosRequestConfig,
	AxiosResponse,
	AxiosError
} from 'axios';

import { apiBaseURL } from '@/config';

/**
 * 统一的 API 响应格式接口定义
 * 
 * @template T - 返回数据的具体类型
 * @property code - 状态码
 * @property message - 错误或提示信息
 * @property data - 实际响应的数据内容
 */
interface ApiResponse<T> {
	code: number;
	message: string; // 用一个更具体的字段来描述错误信息
	data: T;
}

/**
 * 封装了 axios 请求逻辑的类，提供统一的请求配置、拦截器处理以及常用的 HTTP 方法。
 * 支持 GET、POST、PUT 和 DELETE 请求，并自动在请求头中加入认证 Token（如果存在）。
 */
export class Request {
	private instance: AxiosInstance;
	private defaultConfig: AxiosRequestConfig = { baseURL: apiBaseURL, timeout: 6000 };

	/**
	 * 构造函数：初始化 axios 实例并设置默认配置与拦截器
	 * 
	 * @param config - 自定义 axios 配置项，将与默认配置合并使用
	 */
	constructor(config: AxiosRequestConfig) {
		const mergedConfig = { ...this.defaultConfig, ...config }; // 使用浅拷贝
		this.instance = axios.create(mergedConfig);

		// 请求拦截器：用于注入 Authorization 头部中的 token
		this.instance.interceptors.request.use(
			(config: InternalAxiosRequestConfig) => {
				const token = this.getToken(); // 使用一个独立的方法来获取 token
				if (token) {
					config.headers.Authorization = token;
				}
				return config;
			},
			(error: AxiosError) => {
				return Promise.reject(error);
			}
		);

		// 响应拦截器：统一处理响应错误，提取后端返回的错误信息
		this.instance.interceptors.response.use(
			(response: AxiosResponse) => {
				return response;
			},
			(error: AxiosError) => {
				const apiError = error.response?.data; // 修改到更具体的错误信息字段
				return Promise.reject(apiError);
			}
		);
	}

	/**
	 * 发起任意类型的 HTTP 请求
	 * 
	 * @param config - 完整的 axios 请求配置对象
	 * @returns 返回原始的 axios 响应 Promise
	 */
	public request(config: AxiosRequestConfig): Promise<any> {
		return this.instance.request(config);
	}

	/**
	 * 发起 GET 请求
	 * 
	 * @template TResponse - 响应体中 data 字段的类型
	 * @param url - 请求地址
	 * @param config - 可选的额外 axios 配置
	 * @returns 包含标准 ApiResponse 格式的响应 Promise
	 */
	public get<TResponse = any>(
		url: string,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.get(url, config);
	}

	/**
	 * 发起 POST 请求
	 * 
	 * @template TRequest - 请求体数据的类型
	 * @template TResponse - 响应体中 data 字段的类型
	 * @param url - 请求地址
	 * @param data - 要发送的数据体
	 * @param config - 可选的额外 axios 配置
	 * @returns 包含标准 ApiResponse 格式的响应 Promise
	 */
	public post<TRequest = any, TResponse = any>(
		url: string,
		data?: TRequest,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.post(url, data, config);
	}

	/**
	 * 发起 PUT 请求
	 * 
	 * @template TRequest - 请求体数据的类型
	 * @template TResponse - 响应体中 data 字段的类型
	 * @param url - 请求地址
	 * @param data - 要更新的数据体
	 * @param config - 可选的额外 axios 配置
	 * @returns 包含标准 ApiResponse 格式的响应 Promise
	 */
	public put<TRequest = any, TResponse = any>(
		url: string,
		data?: TRequest,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.put(url, data, config);
	}

	/**
	 * 发起 DELETE 请求
	 * 
	 * @template TResponse - 响应体中 data 字段的类型
	 * @param url - 请求地址
	 * @param config - 可选的额外 axios 配置
	 * @returns 包含标准 ApiResponse 格式的响应 Promise
	 */
	public delete<TResponse = any>(
		url: string,
		config?: AxiosRequestConfig
	): Promise<AxiosResponse<ApiResponse<TResponse>>> {
		return this.instance.delete(url, config);
	}

	/**
	 * 获取存储在 sessionStorage 中的认证 Token
	 * 
	 * @returns 若存在则返回 token 字符串，否则返回 null
	 */
	private getToken(): string | null {
		return JSON.parse(sessionStorage.getItem('better-chat.authToken') || 'null');
	}
}

export default new Request({});