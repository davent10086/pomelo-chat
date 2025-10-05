import React  from "react";
import { Navigate } from "react-router-dom";
import { tokenStorage } from "@/utils/storage";

/**
 * 私有路由组件的属性接口
 */
interface IprivateRouteProps {
  /**
   * 需要受保护的路由元素
   */
  element: React.ReactElement;
}

/**
 * 私有路由组件，用于保护需要认证的路由
 * @param props - 私有路由组件的属性
 * @param props.element - 需要受保护的路由元素
 * @returns 如果用户已认证则返回传入的元素，否则重定向到登录页面
 */
const  PrivateRoute = (props: IprivateRouteProps) => {
    const { element } = props;
    const authToken = tokenStorage.getItem();
    
    // 检查用户是否已认证
    if (authToken) {
        return <>{element}</>;
    }
    
    // 未认证用户重定向到登录页面
    return(
        <>
            <Navigate to="/login" />
        </>
    );
};

/**
 * 高阶组件，用于包装需要私有路由保护的组件
 * @param Component - 需要受保护的组件
 * @returns 包装后的组件，该组件会通过私有路由进行访问控制
 */
export const WithPrivateRoute = (Component:React.ElementType) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WrappedComponent = (props:any) => {
        return <PrivateRoute element ={<Component {...props} />}/>
    };
    return WrappedComponent;
};