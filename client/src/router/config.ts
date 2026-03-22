import { lazy } from 'react';

import { withPrivateRoute } from './private';

import Login from '@/pages/login';
import Register from '@/pages/register';

/**
 * 路由配置项接口定义
 * 定义了路由对象的基本结构和属性类型
 */
export interface IRouter {
	/** 路由名称（可选） */
	name?: string;
	/** 重定向路径（可选） */
	redirect?: string;
	/** 路由路径，必须指定 */
	path: string;
	/** 子路由数组（可选） */
	children?: Array<IRouter>;
	/** 路由对应的组件，必须指定 */
	component: React.ComponentType;
}

/**
 * 应用路由配置数组
 * 包含所有页面路由的配置信息，定义了应用的路由结构
 * 
 * 路由结构说明：
 * - 根路径 '/' 配置了需要登录权限的主页，包含子路由
 * - 登录和注册页面为公共页面，无需登录即可访问
 * - 通配符路由 '*' 用于处理未匹配的路径，重定向到首页
 */
export const router: Array<IRouter> = [
	{
		path: '/',
		component: withPrivateRoute(lazy(() => import('@/pages/home'))), // 需要登录才能访问的页面
		children: [
			{
				path: 'chat',
				component: withPrivateRoute(lazy(() => import('@/pages/home')))
			},
			{
				path: 'address-book',
				component: withPrivateRoute(lazy(() => import('@/pages/home')))
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