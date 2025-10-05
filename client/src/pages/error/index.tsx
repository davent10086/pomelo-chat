import { Empty } from 'antd';
import React from 'react';

/**
 * 一个简单的兜底页面，用于展示 404 等错误页面
 * 该组件渲染一个居中的空状态提示，适用于错误页面场景
 */
const BottomPage = () => (
	<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
		<Empty description={false} />
	</div>
);

export default BottomPage;