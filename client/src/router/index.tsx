import { Spin } from 'antd';
import { Suspense, useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { IRouter, router } from './config';

/**
 * 居中显示的加载指示器组件
 * 当路由组件正在加载时显示此组件
 */
const CenteredSpin = () => (
	<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
		<Spin />
	</div>
);

/**
 * 路由渲染组件
 * 负责根据路由配置递归渲染所有路由，并处理路由守卫和懒加载
 */
const RouteRender = () => {
	/**
	 * 递归地渲染路由配置
	 * @param router 路由配置数组
	 * @returns 路由组件列表
	 */
	const routeRender = (router: Array<IRouter>) => {
		return router.map(item => {
			return (
				<Route
					key={item.name || item.path}
					path={item.path}
					element={
						item.redirect ? (
							<Navigate to={item.redirect} />
						) : (
							<Suspense fallback={<CenteredSpin />}>
								<item.component />
							</Suspense>
						)
					}
				>
					{item.children && routeRender(item.children)}
				</Route>
			);
		});
	};

	// 使用 useMemo 来记忆化 router 映射的结果，避免每次渲染都重新计算
	const routes = useMemo(() => {
		return routeRender(router);
	}, [router]);

	return <Routes>{routes}</Routes>;
};

export default RouteRender;
