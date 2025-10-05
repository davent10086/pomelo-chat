import { lazy } from 'react';

import { WithPrivateRoute } from './private';

import Login from '@/pages/login';
import Register from '@/pages/register';

/**
 * 路由配置项接口
 * 定义了路由的基本结构和属性
 */
export interface IRouter {
	/**
	 * 路由名称（可选）
	 */
	name?: string;
	/**
	 * 重定向路径（可选）
	 */
	redirect?: string;
	/**
	 * 路由路径
	 */
	path: string;
	/**
	 * 子路由列表（可选）
	 */
	children?: Array<IRouter>;
	/**
	 * 路由对应的组件
	 */
	component: React.ComponentType;
}

/**
 * 应用路由配置
 * 定义了整个应用的路由映射关系
 */
export const router: Array<IRouter> = [
	{
		path: '/',
		component: WithPrivateRoute(lazy(() => import('@/pages/home'))), // 需要登录才能访问的页面
		children: [
			{
				path: 'chat',
				component: WithPrivateRoute(lazy(() => import('@/pages/home')))
			},
			{
				path: 'address-book',
				component: WithPrivateRoute(lazy(() => import('@/pages/home')))
			}
		]
	},
	{
		path: '/login',
		component: Login
	},
	{
		path: '/register',
		component: Register
	},
	{
		path: '*',
		component: lazy(() => import('@/pages/error')),
		redirect: '/'
	}
];