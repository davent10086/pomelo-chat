/**
 * Home 页面组件
 * 
 * 这是应用程序的主页组件，提供背景容器并渲染 Container 组件
 */
import styles from './index.module.less';
import Container from '../container';
import React from'react';

const Home = () => {
	return (
		<>
			{/* 背景容器 */}
			<div className={styles.bgContainer}>
				<Container />
			</div>
		</>
	);
};

export default Home;