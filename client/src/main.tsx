import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import '@/assets/styles/global.less';
import RouteRender from '@/router';
import { initializeDesktopSync } from '@/desktop/bridge';
import DesktopTitleBar from '@/desktop/TitleBar';

initializeDesktopSync();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<BrowserRouter>
		<ConfigProvider
			theme={{
				token: {
					fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
					colorPrimary: '#07C160'
				}
			}}
			locale={zhCN}
		>
			<App>
				<DesktopTitleBar />
				<RouteRender />
			</App>
		</ConfigProvider>
	</BrowserRouter>
);
