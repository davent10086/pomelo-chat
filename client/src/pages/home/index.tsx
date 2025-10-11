/**
 * Home页面组件
 * 
 * 该组件是应用的主页，渲染背景容器并包含Container子组件。
 * 
 * @returns 返回Home页面的JSX元素
 */
import styles from './index.module.less';
import Container from '../container';

const Home = () => {
	return (
		<>
			<div className={styles.bgContainer}>
				<Container />
			</div>
		</>
	);
};

export default Home;
