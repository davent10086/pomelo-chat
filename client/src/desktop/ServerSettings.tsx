import { Alert, Button, Form, Input, Modal } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { isDesktopAssistant } from './bridge';
import { tokenStorage } from '@/utils/storage';
import './server-settings.less';

export default function DesktopServerSettings({ children }: { children: ReactNode }) {
	const bridge = window.pomeloDesktop;
	const runtime = bridge?.getRuntime();
	const required = Boolean(runtime?.packaged && !runtime.serverURL);
	const [open, setOpen] = useState(false);
	const [address, setAddress] = useState(runtime?.serverURL || '');
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState('');
	const [tested, setTested] = useState(false);
	useEffect(() => {
		const show = () => { setNotice(''); setTested(false); setOpen(true); };
		window.addEventListener('pomelo-server-settings', show);
		return () => window.removeEventListener('pomelo-server-settings', show);
	}, []);
	if (!bridge || isDesktopAssistant()) return <>{children}</>;
	const loggedIn = Boolean(tokenStorage.getItem());
	const save = async () => {
		setBusy(true); setNotice('');
		try { await bridge.setServer(address); }
		catch (error) { setNotice(error instanceof Error ? error.message : '保存失败，请重试'); setBusy(false); }
	};
	const test = async () => {
		setBusy(true); setNotice(''); setTested(false);
		try {
			const url = new URL(address.trim());
			if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
				throw new Error('请填写服务器根地址，例如 https://chat.example.com');
			if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
				throw new Error('远程服务器需使用 HTTPS');
			const response = await fetch(`${url.origin}/api/chat/v1/health`, { signal: AbortSignal.timeout(8000), credentials: 'omit', redirect: 'error' });
			const body = await response.json();
			if (!response.ok || body.service !== 'pomelo-chat') throw new Error('服务器未返回 Pomelo Chat 服务标识');
			setTested(true); setNotice('连接成功，可以保存并连接。');
		} catch (error) { setNotice(error instanceof Error ? error.message : '连接失败，请检查地址和服务端 CORS 配置'); }
		finally { setBusy(false); }
	};
	const form = <div className="desktop-server-form">
		<p>连接团队部署的 Pomelo Chat 服务器。电脑上无需安装数据库。</p>
		<Form layout="vertical" onFinish={() => void save()}>
			<Form.Item label="服务器地址" required>
				<Input aria-label="服务器地址" value={address} placeholder="https://chat.example.com" disabled={busy || loggedIn}
					onChange={event => { setAddress(event.target.value); setNotice(''); setTested(false); }} />
			</Form.Item>
			<p className="server-hint">本机开发支持 http://127.0.0.1:3000。保存后窗口将重新打开；不同服务器的数据互相隔离。</p>
			{loggedIn && <Alert type="info" message="请先退出登录，再切换服务器。" />}
			{notice && <Alert type={tested ? 'success' : 'warning'} message={notice} showIcon />}
			<div className="server-actions">
				<Button onClick={() => void test()} disabled={!address.trim() || busy || loggedIn}>测试连接</Button>
				<Button type="primary" htmlType="submit" loading={busy} disabled={!address.trim() || loggedIn}>保存并连接</Button>
			</div>
		</Form>
	</div>;
	if (required) return <main className="desktop-setup"><section><h1>连接 Pomelo Chat</h1>{form}</section></main>;
	return <>{children}<Modal title="服务器设置" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnClose>{form}</Modal></>;
}
