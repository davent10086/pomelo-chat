// ... existing code ...
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

// 导入全局样式文件
import '@/assets/styles/global.less';
// 导入路由组件
import RouteRender from '@/router';

// 创建React根节点并渲染应用
// 配置应用主题和中文语言环境
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<BrowserRouter>
		<ConfigProvider
			theme={{
				token: {
					colorPrimary: '#28a770'
				}
			}}
			locale={zhCN}
		>
			<App>
				<RouteRender />
			</App>
		</ConfigProvider>
	</BrowserRouter>
);
