import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import styles from './index.module.less';
import { IChatContainerProps } from './type';

import AIChatSummary from '@/components/AIChatSummary';
import MessageShow from '@/components/MessageShow';
import { IMessageItem } from '@/components/MessageShow/type';

import { mergeMessages } from '@/utils/message-merge';

// M6: 动态高度虚拟滚动 —— 估算高度 + 实际测量
const ESTIMATE_ITEM_HEIGHT = 60; // 初始估算高度
const BUFFER_SIZE = 10;

/**
 * 聊天容器组件
 * M2: 移除 window.dispatchEvent，改用回调
 * M5: messageCache 在消息变更时清理，避免内存泄漏
 * M6: 动态高度虚拟滚动
 * L2: isAtBottomRef 改为 state 镜像，确保重渲染
 */
const ChatContainer = (props: IChatContainerProps) => {
	const {
		historyMsg,
		newMsg,
		hasMoreHistory,
		onLoadMoreHistory,
		historyLoading,
		focusMessageId,
		onRetry,
		onCancelRetry,
		onAtBottomChange
	} = props;
	const chatContainerRef = useRef<HTMLDivElement>(null);
	const messagesWrapRef = useRef<HTMLDivElement>(null);
	const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });
	const [summary, setSummary] = useState('');
	const [followNew, setFollowNew] = useState<boolean>(true);
	// L2: 使用 state 镜像 isAtBottom，确保 FAB 按钮正确重渲染
	const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
	const initialScroll = useRef(false);
	const focusPinned = useRef(true);
	const anchor = useRef<{ key: string; offset: number }>();
	const isAtBottomRef = useRef<boolean>(true);

	const [layoutVersion, setLayoutVersion] = useState(0);

	// M6: 测量高度缓存
	const measuredHeights = useRef<Map<string, number>>(new Map());

	const allMessages = useMemo(() => {
		return mergeMessages(historyMsg || [], newMsg || []);
	}, [historyMsg, newMsg]);

	useEffect(() => {
		onAtBottomChange?.(isAtBottom);
	}, [isAtBottom, onAtBottomChange]);
	useEffect(() => {
		const wrapper = messagesWrapRef.current;
		if (!wrapper) return;
		const observer = new ResizeObserver(() => {
			let changed = false;
			wrapper.querySelectorAll<HTMLElement>('[data-message-index]').forEach(el => {
				const index = Number(el.dataset.messageIndex);
				const height = el.offsetHeight;
				if (
					height > 0 &&
					measuredHeights.current.get(getMessageKey(allMessages[index], index)) !== height
				) {
					measuredHeights.current.set(getMessageKey(allMessages[index], index), height);
					changed = true;
				}
			});
			if (changed) setLayoutVersion(value => value + 1);
		});
		wrapper.querySelectorAll('[data-message-index]').forEach(el => observer.observe(el));
		return () => observer.disconnect();
	}, [allMessages, visibleRange]);
	// M6: 累计高度计算（基于测量值或估算值）
	const getCumulativeHeight = useCallback((index: number) => {
		let total = 0;
		for (let i = 0; i < Math.min(index, allMessages.length); i++) {
			total +=
				measuredHeights.current.get(getMessageKey(allMessages[i], i)) || ESTIMATE_ITEM_HEIGHT;
		}
		return total;
	}, [allMessages]);

	const getTotalHeight = () => {
		return getCumulativeHeight(allMessages.length);
	};

	useEffect(() => {
		focusPinned.current = true;
		const container = chatContainerRef.current;
		const unpin = () => {
			focusPinned.current = false;
			initialScroll.current = true;
		};
		container?.addEventListener('wheel', unpin, { passive: true });
		container?.addEventListener('touchstart', unpin, { passive: true });
		return () => {
			container?.removeEventListener('wheel', unpin);
			container?.removeEventListener('touchstart', unpin);
		};
	}, [focusMessageId]);
	useEffect(() => {
		if (!focusMessageId || !chatContainerRef.current || !focusPinned.current) return;
		const index = allMessages.findIndex(message => Number(message.id) === focusMessageId);
		if (index < 0) return;
		setFollowNew(false);
		setVisibleRange({
			start: Math.max(0, index - BUFFER_SIZE),
			end: Math.min(allMessages.length, index + BUFFER_SIZE)
		});
		let innerFrame = 0;
		const frame = requestAnimationFrame(() => {
			if (chatContainerRef.current && messagesWrapRef.current) {
				chatContainerRef.current.scrollTop =
					messagesWrapRef.current.offsetTop + getCumulativeHeight(index);
			}
			innerFrame = requestAnimationFrame(() => {
				chatContainerRef.current
					?.querySelector(`[data-message-id="${focusMessageId}"]`)
					?.scrollIntoView({ block: 'center' });
			});
		});
		return () => {
			cancelAnimationFrame(frame);
			cancelAnimationFrame(innerFrame);
		};
	}, [focusMessageId, layoutVersion, allMessages, getCumulativeHeight]);

	useLayoutEffect(() => {
		const container = chatContainerRef.current;
		if (!container || !allMessages.length || (focusMessageId && focusPinned.current)) return;
		if (!initialScroll.current) {
			initialScroll.current = true;
			const end = allMessages.length;
			setVisibleRange({ start: Math.max(0, end - 30), end });
			const frame = requestAnimationFrame(() => {
				container.scrollTop = container.scrollHeight;
			});
			return () => cancelAnimationFrame(frame);
		}
		if (!isAtBottomRef.current && anchor.current) {
			const index = allMessages.findIndex(
				(message, i) => getMessageKey(message, i) === anchor.current!.key
			);
			if (index >= 0)
				container.scrollTop =
					(messagesWrapRef.current?.offsetTop || 0) +
					getCumulativeHeight(index) +
					anchor.current.offset;
		}
	}, [allMessages, focusMessageId, getCumulativeHeight]);

	// 计算可见范围（M6: 动态高度）
	useEffect(() => {
		if (!chatContainerRef.current) return;
		const container = chatContainerRef.current;
		const handleScroll = () => {
			const distanceToBottom =
				container.scrollHeight - container.scrollTop - container.clientHeight;
			const dynamicBuffer = distanceToBottom <= 100 ? BUFFER_SIZE * 4 : BUFFER_SIZE;
			const listOffsetTop = messagesWrapRef.current ? messagesWrapRef.current.offsetTop : 0;
			const relativeScrollTop = Math.max(0, container.scrollTop - listOffsetTop);

			// M6: 动态高度计算 start
			let anchorIndex = 0;
			let start = 0;
			let accHeight = 0;
			for (let i = 0; i < allMessages.length; i++) {
				const h =
					measuredHeights.current.get(getMessageKey(allMessages[i], i)) || ESTIMATE_ITEM_HEIGHT;
				if (accHeight + h >= relativeScrollTop) {
					anchorIndex = i;
					start = Math.max(0, i - dynamicBuffer);
					break;
				}
				accHeight += h;
			}
			// 计算 end
			let end = start;
			let visibleHeight = 0;
			while (
				end < allMessages.length &&
				visibleHeight < container.clientHeight + dynamicBuffer * ESTIMATE_ITEM_HEIGHT
			) {
				visibleHeight +=
					measuredHeights.current.get(getMessageKey(allMessages[end], end)) || ESTIMATE_ITEM_HEIGHT;
				end++;
			}
			end = Math.min(allMessages.length, end + dynamicBuffer);

			setVisibleRange({ start, end });
			if (allMessages[anchorIndex])
				anchor.current = {
					key: getMessageKey(allMessages[anchorIndex], anchorIndex),
					offset: relativeScrollTop - accHeight
				};

			// L2: 同步更新 ref 与 state
			isAtBottomRef.current = distanceToBottom <= 20;
			setIsAtBottom(distanceToBottom <= 20);
		};

		container.addEventListener('scroll', handleScroll);
		handleScroll();
		return () => {
			container.removeEventListener('scroll', handleScroll);
		};
	}, [allMessages, layoutVersion]);

	// M5: 消息列表变更时清理缓存，避免跨会话污染与内存泄漏
	useEffect(() => {
		const keys = new Set(allMessages.map(getMessageKey));
		for (const key of measuredHeights.current.keys())
			if (!keys.has(key)) measuredHeights.current.delete(key);
	}, [allMessages]);

	const scrollToBottom = () => {
		if (chatContainerRef.current) {
			chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
		}
	};

	function getMessageKey(message: IMessageItem, index: number) {
		const maybeId = (message as unknown as { id?: string | number }).id;
		if (message.clientMsgId || message.client_msg_id)
			return `${message.sender_id}:${message.clientMsgId || message.client_msg_id}`;
		if (maybeId !== undefined && maybeId !== null) return String(maybeId);
		const created =
			message.created_at instanceof Date
				? message.created_at.toISOString()
				: String(message.created_at ?? '');
		const sender = String(message.sender_id ?? '');
		const snippet = (message.content ?? '').slice(0, 20);
		return `${created}-${sender}-${snippet}-${index}`;
	}

	useEffect(() => {
		if (focusMessageId) return;
		if (newMsg && newMsg.length > 0) {
			if (isAtBottomRef.current && followNew) {
				if (chatContainerRef.current) {
					const container = chatContainerRef.current;
					const visibleCount =
						Math.ceil(container.clientHeight / ESTIMATE_ITEM_HEIGHT) + BUFFER_SIZE * 4;
					const end = allMessages.length;
					const start = Math.max(0, end - visibleCount);
					if (visibleRange.end < end) {
						setVisibleRange({ start, end });
					}
				}
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						scrollToBottom();
					});
				});
			}
		}
	}, [newMsg, followNew, focusMessageId, allMessages.length, visibleRange.end]);

	const renderMessage = (message: IMessageItem, index: number) => {
		const cacheKey = getMessageKey(message, index);
		const prev = allMessages[index - 1];
		const prevTime = prev ? new Date(prev.created_at).getTime() : 0;
		const curTime = message.created_at ? new Date(message.created_at).getTime() : 0;
		const showTime = index === 0 || (index > 0 && curTime - prevTime > 5 * 60 * 1000);

		// M6: 测量元素实际高度的 ref 回调
		const measureRef = (el: HTMLDivElement | null) => {
			if (el) {
				const height = el.offsetHeight;
				if (
					height > 0 &&
					measuredHeights.current.get(getMessageKey(allMessages[index], index)) !== height
				) {
					measuredHeights.current.set(getMessageKey(message, index), height);
				}
			}
		};

		const element = (
			<div
				key={cacheKey}
				data-message-index={index}
				data-message-id={message.id}
				className={styles.chat_item}
				ref={measureRef}
				style={Number(message.id) === focusMessageId ? { outline: '2px solid #f0a94a' } : undefined}
			>
				<MessageShow
					showTime={showTime}
					message={message}
					onRetry={onRetry}
					onCancelRetry={onCancelRetry}
				/>
			</div>
		);

		return element;
	};

	// M6: 占位高度用累计实际高度
	const topPlaceholderHeight = getCumulativeHeight(visibleRange.start);
	const bottomPlaceholderHeight = Math.max(
		0,
		getTotalHeight() - getCumulativeHeight(visibleRange.end)
	);

	return (
		<div className={styles.chat_root}>
			<div ref={chatContainerRef} className={`${styles.chat_container}`}>
				{props.summarySlot ? createPortal(<AIChatSummary historyMsg={allMessages} onSummaryComplete={setSummary} />, props.summarySlot) : null}
				{summary && (
					<div className={`${styles.summary_display}`}>
						<h4>AI 总结</h4>
						<p>{summary}</p>
					</div>
				)}
				{hasMoreHistory && (
					<div className={styles.history_load_more}>
						<button type="button" onClick={onLoadMoreHistory} disabled={historyLoading}>
							{historyLoading ? '加载中...' : '加载更早消息'}
						</button>
					</div>
				)}
				<div ref={messagesWrapRef}>
					<div style={{ height: `${topPlaceholderHeight}px` }} />
					{allMessages.slice(visibleRange.start, visibleRange.end).map((message, index) => {
						const actualIndex = visibleRange.start + index;
						return renderMessage(message, actualIndex);
					})}
					<div style={{ height: `${bottomPlaceholderHeight}px` }} />
				</div>
			</div>
			<div className={styles.fab_container}>
				{/* L2: 使用 state 镜像 isAtBottom 确保 FAB 正确重渲染 */}
				{!isAtBottom && (
					<button className={styles.scroll_fab} onClick={scrollToBottom}>
						回到底部
					</button>
				)}
				<label className={styles.follow_toggle}>
					<input
						type="checkbox"
						checked={followNew}
						onChange={e => setFollowNew(e.target.checked)}
					/>
					<span>跟随新消息</span>
				</label>
			</div>

		</div>
	);
};

export default ChatContainer;
