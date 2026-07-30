import React from 'react';
import { Navigate } from 'react-router-dom';

import { tokenStorage } from '@/utils/storage';
interface IPrivateRouteProps {
	element: React.ReactNode;
}

const PrivateRoute = (props: IPrivateRouteProps) => {
	const { element } = props;
	const authToken = tokenStorage.getItem();
	if (authToken) {
		return <>{element}</>;
	}
	return (
		<>
			<Navigate to="/login" />;
		</>
	);
};
// 高阶组件HOC，用于给需要登录才能访问的页面添加路由守卫
export const withPrivateRoute = <Props extends object>(Component: React.ComponentType<Props>) => {
	const WrappedComponent = (props: Props) => {
		return <PrivateRoute element={<Component {...props} />} />;
	};
	WrappedComponent.displayName = `withPrivateRoute(${Component.displayName || Component.name || 'Component'})`;
	return WrappedComponent;
};
