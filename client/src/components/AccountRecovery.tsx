import { useState } from 'react';
import { Button, Form, Input, Modal, message } from 'antd';
import Request from '@/utils/request';

export default function AccountRecovery({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [busy, setBusy] = useState(false);
	const [form] = Form.useForm();
	return <Modal title="找回密码" open={open} footer={null} maskClosable={false}
		onCancel={() => { if (!busy) { form.resetFields(); onClose(); } }}>
		<Form form={form} layout="vertical" onFinish={async values => {
			setBusy(true);
			try {
				const response = await Request.post('/auth/recover_password', { phone: values.phone, password: values.password });
				if (response.data.code !== 200) throw new Error(response.data.message || '重置失败');
				message.success('密码已重置，请使用新密码登录'); form.resetFields(); onClose();
			} catch (error) {
				message.error((error as { message?: string })?.message || '操作失败，请重试');
			} finally { setBusy(false); }
		}}>
			<Form.Item name="phone" label="手机号" rules={[{ required: true }, { pattern: /^1[3-9]\d{9}$/, message: '请输入有效手机号' }]}><Input autoComplete="tel" /></Form.Item>
			<Form.Item name="password" label="新密码" rules={[{ required: true }, { min: 8, message: '至少 8 个字符，最多 72 字节' }]}><Input.Password autoComplete="new-password" /></Form.Item>
			<Form.Item name="confirm" label="确认新密码" dependencies={['password']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次密码不一致')) })]}><Input.Password autoComplete="new-password" /></Form.Item>
			<Button type="primary" htmlType="submit" loading={busy}>重置密码</Button>
		</Form>
	</Modal>;
}
