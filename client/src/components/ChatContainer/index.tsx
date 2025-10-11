import { Button, message } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import React from 'react';

import styles from './index.module.less';
import { IChatContainerProps } from './type';

import AIChatSummary from '@/components/AIChatSummary';
import MessageShow from '@/components/MessageShow';
import { formatChatContentTime } from '@/utils/time';

const ITEM_HEIGHT = 60; // 每条消息的估计高度
const BUFFER_SIZE = 10; // 增加缓冲区大小以减少闪烁

/**
 * 聊天容器组件
 * 
 * 该组件负责渲染聊天消息列表，支持虚拟滚动以提高性能，
 * 并集成了AI聊天总结功能。
 * 
 * @param props - 组件属性
 * @param props.historyMsg - 历史消息数组
 * @param props.newMsg - 新消息数组
 * @returns 聊天容器组件
 */
const ChatContainer = (props: IChatContainerProps) => {
	const { historyMsg, newMsg } = props;
	const chatContainerRef = useRef<HTMLDivElement>(null);
	const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });
	const [summary, setSummary] = useState('');
	const messageCache = useRef<Map<number, JSX.Element>>(new Map()); // 缓存已渲染的消息组件

	// 合并所有消息
	const allMessages = useMemo(() => {
		return [...(historyMsg || []), ...(newMsg || [])];
	}, [historyMsg, newMsg]);

	// 计算可见范围
	useEffect(() => {
		if (!chatContainerRef.current) return;

		const container = chatContainerRef.current;
		const handleScroll = () => {
			// 计算可见范围
			const start = Math.max(0, Math.floor(container.scrollTop / ITEM_HEIGHT) - BUFFER_SIZE);
			const end = Math.min(
				allMessages.length,
				start + Math.ceil(container.clientHeight / ITEM_HEIGHT) + BUFFER_SIZE * 2
			);

			setVisibleRange({ start, end });
		};

		container.addEventListener('scroll', handleScroll);
		handleScroll(); // 初始化

		return () => {
			container.removeEventListener('scroll', handleScroll);
		};
	}, [allMessages.length]);

	// 清除消息缓存
	const clearMessageCache = () => {
		messageCache.current.clear();
	};

	// 当消息列表改变时，清除缓存
	useEffect(() => {
		clearMessageCache();
	}, [historyMsg, newMsg]);

	// 滚动到底部
	const scrollToBottom = () => {
		if (chatContainerRef.current) {
			chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
		}
	};

	// 当有新消息时滚动到底部
	useEffect(() => {
		if (newMsg && newMsg.length > 0) {
			setTimeout(() => {
				scrollToBottom();
			}, 100);
		}
	}, [newMsg]);

	// 渲染单个消息
	const renderMessage = (message: any, index: number) => {
		// 尝试从缓存中获取消息组件
		if (messageCache.current.has(index)) {
			return messageCache.current.get(index);
		}

		// 计算是否显示时间
		const showTime = index === 0 || (index > 0 && new Date(message.created_at).getTime() - new Date(allMessages[index - 1].created_at).getTime() > 5 * 60 * 1000);

		const element = (
			<div key={message.id} className={styles.chat_item}>
				<MessageShow showTime={showTime} message={message} />
			</div>
		);

		// 缓存消息组件
		messageCache.current.set(index, element);
		return element;
	};

	return (
		<div 
			ref={chatContainerRef} 
			className={`${styles.chat_container}`}
		>
			<AIChatSummary historyMsg={allMessages} onSummaryComplete={setSummary} />
			{summary && (
				<div className={`${styles.summary_display}`}>
					<h4>AI 总结</h4>
					<p>{summary}</p>
				</div>
			)}
			{allMessages.slice(visibleRange.start, visibleRange.end).map((message, index) => {
				const actualIndex = visibleRange.start + index;
				return renderMessage(message, actualIndex);
			})}
		</div>
	);
};

export default ChatContainer;