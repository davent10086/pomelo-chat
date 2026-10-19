import { useState } from 'react';
import { isDesktopAssistant } from './bridge';
import './titlebar.less';

export default function DesktopTitleBar() {
	const [maximized, setMaximized] = useState(false);
	const bridge = window.pomeloDesktop;
	if (!bridge || isDesktopAssistant()) return null;
	const maximize = () => void bridge.windowControl('maximize').then(setMaximized);
	return <header className="desktop-titlebar" onDoubleClick={maximize}>
		<span>Pomelo Chat</span>
		<div onDoubleClick={event => event.stopPropagation()}>
			<button aria-label="服务器设置" onClick={() => window.dispatchEvent(new Event('pomelo-server-settings'))}>⚙</button>
			<button aria-label="最小化" onClick={() => void bridge.windowControl('minimize')}>−</button>
			<button aria-label={maximized ? '还原窗口' : '最大化'} onClick={maximize}>{maximized ? '❐' : '□'}</button>
			<button className="desktop-close" aria-label="关闭窗口" onClick={() => void bridge.windowControl('close')}>×</button>
		</div>
	</header>;
}
