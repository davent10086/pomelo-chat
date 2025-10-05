import { App } from 'antd';

// 全局提示弹窗封装
/**
 * 全局提示弹窗hook
 * @returns 返回一个函数，用于显示不同类型的提示信息
 * @returns 返回函数的参数说明：
 *   - type: 提示类型，可选值为'success' | 'error' | 'warning' | 'info'
 *   - text: 提示文本内容
 *   - duration: 提示显示持续时间（秒），可选参数，默认1.5秒
 */
const useShowMessage = () => {
	const { message } = App.useApp();
	// 返回一个函数，根据传入的类型调用对应的message方法显示提示
	return (type: 'success' | 'error' | 'warning' | 'info', text: string, duration?: number) => {
		message[type](text, duration || 1.5);
	};
};
export default useShowMessage;
