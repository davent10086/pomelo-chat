/**
 * 登录参数接口
 * 定义了用户登录所需的基本参数结构
 */
export interface ILoginParams{
    /**
     * 用户名
     * 用于用户身份识别的唯一标识
     */
    username: string;
    
    /**
     * 密码
     * 用户登录凭证，通常需要加密传输
     */
    password: string;
}

/**
 * 登录表单接口
 * 定义了用户登录表单所需的基本参数结构
 */
export interface ILoginForm{
    /**
     * 用户名
     * 用于用户身份识别的唯一标识
     */
    username: string;
    
    /**
     * 密码
     * 用户登录凭证，通常需要加密传输
     */
    password: string;
}