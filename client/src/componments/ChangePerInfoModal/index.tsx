import { Button, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { handleChange } from './api';
import styles from './index.module.less';
import { IChangePwdForm, IChangePwdModalProps } from './type';

import useShowMessage from '@/hooks/useShowMessage';
import { HttpStatus } from '@/utils/constant';
import { handleLogout } from '@/utils/logout';
import { clearSessionStorage, userStorage } from '@/utils/storage';

/**
 * 修改密码弹窗组件
 * @param props - 组件属性接口 IChangePwdModalProps
 * @param props.openmodal - 控制弹窗显示状态的布尔值
 * @param props.handleModal - 控制弹窗开关的回调函数
 */
const ChangePerInfoModal = (props: IChangePwdModalProps) => {
    const { openmodal, handleModal } = props;
    const showMessage = useShowMessage();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);

    /**
     * 登出确认处理函数
     * 调用登出接口并根据结果跳转至登录页或提示错误信息
     */
    const confirmLogout = async () => {
        try {
            const res = await handleLogout(JSON.parse(userStorage.getItem()));
            if (res.code === HttpStatus.SUCCESS) {
                clearSessionStorage();
                showMessage('success', '登录过期，请重试');
                navigate('/login');
            } else {
                showMessage('error', '登出失败');
            }
        } catch {
            showMessage('error', '登出失败');
        }
    };

    /**
     * 表单提交处理函数
     * 验证两次密码输入是否一致，并调用修改密码接口进行密码更新
     * @param values - 表单数据，包含用户名、手机号、密码和确认密码字段
     */
    const handleSubmit = async (values: IChangePwdForm) => {
        const { username, phone, password, confirm } = values;
        // 验证两次密码输入是否一致
        if (password !== confirm) {
            showMessage('error', '两次密码输入不一致');
            return;
        }
        setLoading(true);
        try {
            const params = {
                username,
                phone,
                password,
                confirmPassword: confirm,
            };
            const res = await handleChange(params);
            if (res.code === HttpStatus.SUCCESS) {
                showMessage('success', '修改成功');
                confirmLogout();
                setLoading(false);
                handleModal(false);
            } else {
                showMessage('error', res.message || '修改失败');
                setLoading(false);
            }
        } catch (error) {
            const errorMessage = (error as Error)?.message || '修改失败，请重试';
            showMessage('error', errorMessage);
            setLoading(false);
        }
    };

    return (
        <>
            <Modal
                title="修改密码"
                open={openmodal}
                confirmLoading={loading}
                onCancel={() => {
                    handleModal(false);
                }}
                footer={null}
                wrapClassName="changePwdModal"
            >
                <Form name="changePwdForm" onFinish={handleSubmit} className={styles.changePwdForm}>
                    <Form.Item
                        name="username"
                        rules={[
                            { required: true, message: '请输入用户名' },
                            { max: 25, message: '用户名长度不能超过25个字符' }
                        ]}
                    >
                        <Input type="text" placeholder="请输入用户名"></Input>
                    </Form.Item>
                    <Form.Item
                        name="phone"
                        rules={[
                            { required: true, message: '请输入手机号' },
                            { pattern: /^1[3456789]\d{9}$/, message: '请输入有效的手机号码' }
                        ]}
                    >
                        <Input type="phone" placeholder="请输入已绑定的手机号"></Input>
                    </Form.Item>
                    <Form.Item
                        name="password"
                        rules={[
                            { required: true, message: '请输入密码' },
                            { max: 255, message: '密码长度不能超过255个字符' }
                        ]}
                    >
                        <Input type="password" placeholder="请输入密码"></Input>
                    </Form.Item>
                    <Form.Item
                        name="confirm"
                        rules={[
                            { required: true, message: '请确认密码' }
                        ]}
                    >
                        <Input type="password" placeholder="请确认密码"></Input>
                    </Form.Item>
                    <Form.Item>
                        <Button
                            type="default"
                            onClick={() => {
                                handleModal(false);
                            }}
                        >
                            取消
                        </Button>
                        <Button type="primary" htmlType="submit" loading={loading}>
                            确认修改
                        </Button>
                    </Form.Item>
                </Form>
            </Modal>
        </>
    );
};

export default ChangePerInfoModal;