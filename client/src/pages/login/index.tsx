import { Checkbox,Form, Input, Button } from "antd";
import { useEffect, useState } from "react";
import {Link,useNavigate} from "react-router-dom";
import { handleLogin } from "./api";
import styles from "./index.module.less";
import { ILoginForm } from "./type";

import {BgImage} from "@/assets/images"
import {IUserInfo} from "@/componments/ChangePerInfoModal/type"
import ChangePwdModal from "@/componments/ChangePerInfoModal"
import useShowMessage from "@/hooks/useShowMessage";
import { HttpStatus } from "@/utils/constant";
import { generateRandomString, encrypt, decrypt } from "@/utils/encryption";
import {tokenStorage, userStorage} from "@/utils/storage";

/**
 * 记住用户信息，将用户信息和认证令牌加密后存储到localStorage中
 * @param info 用户信息对象
 */
const rememberUser = async (info: IUserInfo) => {
	const userInfo = await encrypt(JSON.stringify(info));
	const authToken = await encrypt(tokenStorage.getItem());
	if (userInfo && authToken) {
		localStorage.setItem('userInfo', userInfo);
		localStorage.setItem('authToken', authToken);
	}
};

/**
 * 获取存储在localStorage中的用户信息和认证令牌，并进行解密
 * @returns 返回包含用户信息和令牌的对象，如果不存在则返回null
 */
const getuserInfo = async () => {
    const userInfo = localStorage.getItem('userInfo');
    const authToken = localStorage.getItem('authToken');
        if (userInfo && authToken) {
            const info = JSON.parse(await decrypt(userInfo));
            const token = await decrypt(authToken);
            return { info, token };
        }
        return null;
    };

/**
 * 登录组件，提供用户登录功能，包括记住我、忘记密码等特性
 */
const Login = () => {
    const showMessage = useShowMessage();
    const navigate = useNavigate();
    const [loading,setLoading] = useState(false);
    const [loginFormInstance] = Form.useForm<ILoginForm>();
    const [isRemember, setIsRemember] = useState(false);
    const [openForgerModal, setForgetModal] = useState(false);

    /**
     * 处理登录表单提交事件
     * @param values 登录表单数据，包含用户名和密码
     */
    const handleSumit = async (values: ILoginForm) => {
        const { username, password } = values;
        // 首先尝试从本地存储获取用户信息进行自动登录
        const res = await getuserInfo();
        if (res && res.info.username === username){
            tokenStorage.setItem(res.token);
            userStorage.setItem(JSON.stringify(res.info));
            showMessage('success','登录成功');
            navigate('/');
            return;
        }else{
            setLoading(true);
            try {
                const params = { username, password };
                const res = await handleLogin(params);
                if (res.code === HttpStatus.SUCCESS && res.data) {
                    showMessage('success','登录成功');
                    setLoading(false);
                    tokenStorage.setItem(res.data.token);
                    userStorage.setItem(JSON.stringify(res.data.info));
                    if (isRemember) {
                        rememberUser(res.data.info);
                    }
                    navigate('/');
                } else {
                    showMessage('error', res.message);
                    setLoading(false);
                }
            }catch {
                showMessage('error', '登录失败，请稍后再试');
                setLoading(false);
            }
        }
    };

    /**
     * 处理记住我功能的切换
     */
    const handleRember = () =>{
        const newIsRemember = !isRemember;
        setIsRemember(newIsRemember);
        localStorage.setItem('isRemember', JSON.stringify(newIsRemember));
        if (newIsRemember === false){
            setIsRemember(false);
            localStorage.removeItem('userInfo');
            localStorage.removeItem('authToken');
        }
    };

    // 组件挂载时尝试获取本地存储的用户信息并填充表单
    useEffect(() => {
        getuserInfo().then(res => {
            if (res) {
                loginFormInstance.setFieldsValue({
                    username: res.info.username,
                    password: generateRandomString()
                });
                setIsRemember(true);
            }else{
                setIsRemember(false);
            }
        });
}, []);

    /**
     * 控制忘记密码模态框的显示与隐藏
     * @param Visible 是否显示模态框
     */
    const handleForgetModal = (Visible:boolean) => {
        setForgetModal(Visible);
    };
    return (
        <>
       <div className={styles.bgContainer} style={{ backgroundImage: `url(${BgImage})`,backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            backgroundAttachment: 'fixed' }}>
            <div className={styles.loginContainer}>
                <div className={styles.text}>
                    <h1>欢迎回来</h1>
                </div>
                <Form name= "loginForm" onFinish={handleSumit} form={loginFormInstance}>
                    <Form.Item name="username" rules={[{required: true, message: '请输入用户名'}]}>
                        <Input placeholder="请输入用户名" maxLength={225}/>
                    </Form.Item>
                    <Form.Item name="password" rules={[{required: true, message: '请输入密码'}]}>
                        <Input.Password placeholder="请输入密码" maxLength={225}/>
                    </Form.Item>
                        <Form.Item>
                            <div className={styles.login_tools}>
                                <div className={styles.rememberTool}>
                                    <Checkbox checked={isRemember} onChange={handleRember}>记住我</Checkbox>
                                </div>
                            <div className={styles.forgetTool} onClick={() => handleForgetModal(true)}>
                                忘记密码？
                            </div>
                        </div>
                </Form.Item>
                <Form.Item>
                    <Button type="primary" className={styles.login_button} loading={loading} htmlType="submit">
                        登录
                    </Button>
                </Form.Item>
                </Form>
                <div className={styles.link}>
                    没有账号？<Link to="/register">注册</Link>
                </div>
            </div>
            {
                openForgerModal && (
                    <ChangePwdModal openmodal={openForgerModal} handleModal={handleForgetModal} />
                )
            }
        </div>
        </>
        );
};

export default Login;