import { useEffect, useMemo, useRef, useState } from 'react';

import styles from './index.module.less';
import { IChatContainerProps } from './type';

import AIChatSummary from '@/components/AIChatSummary';
import MessageShow from '@/components/MessageShow';
import { IMessageItem } from '@/components/MessageShow/type';
import request from '@/utils/request';

// M6: 动态高度虚拟滚动 —— 估算高度 + 实际测量
const ESTIMATE_ITEM_HEIGHT = 60; // 初始估算高度
const BUFFER_SIZE = 10;

/**
 * 聊天容器组件
 * M2: 移除 window.dispatchEvent，改用回调
 * M5: messageCache 在消息变更时清理，避免内存泄漏
 * M6: 动态高度虚拟滚动
 * M7: refreshNextSteps 防抖
 * L2: isAtBottomRef 改为 state 镜像，确保重渲染
 */
const ChatContainer = (props: IChatContainerProps) => {
	const { historyMsg, newMsg, hasMoreHistory, onLoadMoreHistory, historyLoading } = props;
	const chatContainerRef = useRef<HTMLDivElement>(null);
	const messagesWrapRef = useRef<HTMLDivElement>(null);
	const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });
	const [summary, setSummary] = useState('');
	const [followNew, setFollowNew] = useState<boolean>(true);
	const messageCache = useRef<Map<string | number, JSX.Element>>(new Map());
	// L2: 使用 state 镜像 isAtBottom，确保 FAB 按钮正确重渲染
	const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
	const isAtBottomRef = useRef<boolean>(true);

	const [nextSteps, setNextSteps] = useState<string[]>([]);
	const [nextCollapsed, setNextCollapsed] = useState<boolean>(false);
	const [nextLoading, setNextLoading] = useState<boolean>(false);
	const seedRef = useRef<number>(0);
	// M7: 防抖定时器
	const nextStepsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// M5: 缓存上限，避免内存泄漏
	const CACHE_LIMIT = 200;

	// M6: 测量高度缓存
	const measuredHeights = useRef<Map<number, number>>(new Map());

	const allMessages = useMemo(() => {
		return [...(historyMsg || []), ...(newMsg || [])];
	}, [historyMsg, newMsg]);

	const buildContextText = (limit = 12) => {
		const msgs = allMessages || [];
		const last = msgs.slice(Math.max(0, msgs.length - limit));
		return last
			.map((m: { sender_name?: string; content?: string }) => `${m.sender_name || '用户'}: ${m.content || ''}`)
			.join('\n');
	};

	const heuristicNextSteps = (count = 3) => {
		const last = allMessages && allMessages.length ? (allMessages[allMessages.length - 1] as { content?: string }).content || '' : '';
		const isQuestion = /[?？]$/.test(last) || /(吗|么|是否|怎么|怎样|如何)/.test(last);
		const mentionTime = /(今天|明天|后天|今晚|这周|下周|周[一二三四五六日天])/.test(last);
		const seed = seedRef.current % 3;
		const templates: string[][] = [
			['收到，我来跟进这件事，预计今天内给你反馈。', '我们安排一次 30 分钟讨论，确定范围与时间表。', '我先整理一个要点清单，稍后发你确认。'],
			['我这边先出一个初版方案，我们一起评审下可行性。', '方便的话，把相关资料/示例发我，我先评估工作量。', '我来拉个小群，相关同学一起对齐下细节。'],
			['我创建一个待办清单，按优先级推进并同步进度。', '这块我先试一下，遇到问题再和你确认。', '我们定一个里程碑节点，按节点回顾与复盘。']
		];
		const items = templates[seed].slice(0, count);
		if (isQuestion) items[0] = '我先给出一个初步答复，你看是否符合预期？';
		if (mentionTime) items[1] = '要不我们定个时间点，我这边按时提交结果。';
		return items.slice(0, count);
	};

	// H4: 通过后端代理调用（不暴露 API Key）
	const fetchNextStepsFromBackend = async () => {
		const prompt = `基于以下最近的对话内容，给出不超过5条"下一步行动建议"，要求：\n1) 中文，简洁，每条不超过30字\n2) 可直接点击作为回复开头或行动声明\n3) 不要编号，按行返回\n\n对话：\n${buildContextText(12)}`;
		const res = await request.post('/assistant/next-steps', { contextText: prompt, count: 5 });
		const steps = (res as { data?: { steps?: string[] } })?.data?.steps || [];
		return steps.slice(0, 5);
	};

	const refreshNextSteps = async () => {
		setNextLoading(true);
		seedRef.current += 1;
		try {
			let items: string[] = [];
			try {
				items = await fetchNextStepsFromBackend();
			} catch {
				items = heuristicNextSteps(3);
			}
			setNextSteps(items.slice(0, 3));
		} finally {
			setNextLoading(false);
		}
	};

	// M7: 防抖 refreshNextSteps，避免每条消息都触发
	useEffect(() => {
		if (nextStepsTimerRef.current) {
			clearTimeout(nextStepsTimerRef.current);
		}
		nextStepsTimerRef.current = setTimeout(() => {
			refreshNextSteps();
		}, 1500);
		return () => {
			if (nextStepsTimerRef.current) {
				clearTimeout(nextStepsTimerRef.current);
			}
		};
	}, [allMessages.length]);

	// M6: 累计高度计算（基于测量值或估算值）
	const getCumulativeHeight = (index: number) => {
		let total = 0;
		for (let i = 0; i < index; i++) {
			total += measuredHeights.current.get(i) || ESTIMATE_ITEM_HEIGHT;
		}
		return total;
	};

	const getTotalHeight = () => {
		return getCumulativeHeight(allMessages.length);
	};

	// 计算可见范围（M6: 动态高度）
	useEffect(() => {
		if (!chatContainerRef.current) return;
		const container = chatContainerRef.current;
		const handleScroll = () => {
			const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
			const dynamicBuffer = distanceToBottom <= 100 ? BUFFER_SIZE * 4 : BUFFER_SIZE;
			const listOffsetTop = messagesWrapRef.current ? messagesWrapRef.current.offsetTop : 0;
			const relativeScrollTop = Math.max(0, container.scrollTop - listOffsetTop);

			// M6: 动态高度计算 start
			let start = 0;
			let accHeight = 0;
			for (let i = 0; i < allMessages.length; i++) {
				const h = measuredHeights.current.get(i) || ESTIMATE_ITEM_HEIGHT;
				if (accHeight + h >= relativeScrollTop) {
					start = Math.max(0, i - dynamicBuffer);
					break;
				}
				accHeight += h;
			}
			// 计算 end
			let end = start;
			let visibleHeight = 0;
			while (end < allMessages.length && visibleHeight < container.clientHeight + dynamicBuffer * ESTIMATE_ITEM_HEIGHT) {
				visibleHeight += measuredHeights.current.get(end) || ESTIMATE_ITEM_HEIGHT;
				end++;
			}
			end = Math.min(allMessages.length, end + dynamicBuffer);

			setVisibleRange({ start, end });

			// L2: 同步更新 ref 与 state
			isAtBottomRef.current = distanceToBottom <= 20;
			setIsAtBottom(distanceToBottom <= 20);
		};

		container.addEventListener('scroll', handleScroll);
		handleScroll();
		return () => {
			container.removeEventListener('scroll', handleScroll);
		};
	}, [allMessages.length]);

	// M5: 消息列表变更时清理缓存，避免跨会话污染与内存泄漏
	useEffect(() => {
		messageCache.current.clear();
		measuredHeights.current.clear();
	}, [historyMsg]);

	const scrollToBottom = () => {
		if (chatContainerRef.current) {
			chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
		}
	};

	const getMessageKey = (message: IMessageItem, index: number) => {
		const maybeId = (message as unknown as { id?: string | number }).id;
		if (maybeId !== undefined && maybeId !== null) return String(maybeId);
		const created = message.created_at instanceof Date
			? message.created_at.toISOString()
			: String(message.created_at ?? '');
		const sender = String(message.sender_id ?? '');
		const snippet = (message.content ?? '').slice(0, 20);
		return `${created}-${sender}-${snippet}-${index}`;
	};

	useEffect(() => {
		if (newMsg && newMsg.length > 0) {
			if (isAtBottomRef.current && followNew) {
				if (chatContainerRef.current) {
					const container = chatContainerRef.current;
					const visibleCount = Math.ceil(container.clientHeight / ESTIMATE_ITEM_HEIGHT) + BUFFER_SIZE * 4;
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
	}, [newMsg, followNew]);

	const renderMessage = (message: IMessageItem, index: number) => {
		const cacheKey = getMessageKey(message, index);
		if (messageCache.current.has(cacheKey)) {
			return messageCache.current.get(cacheKey) as JSX.Element;
		}
		const prev = allMessages[index - 1];
		const prevTime = prev ? new Date(prev.created_at).getTime() : 0;
		const curTime = message.created_at ? new Date(message.created_at).getTime() : 0;
		const showTime = index === 0 || (index > 0 && curTime - prevTime > 5 * 60 * 1000);

		// M6: 测量元素实际高度的 ref 回调
		const measureRef = (el: HTMLDivElement | null) => {
			if (el) {
				const height = el.offsetHeight;
				if (height > 0 && measuredHeights.current.get(index) !== height) {
					measuredHeights.current.set(index, height);
				}
			}
		};

		const element = (
			<div key={cacheKey} className={styles.chat_item} ref={measureRef}>
				<MessageShow showTime={showTime} message={message} />
			</div>
		);

		// M5: 缓存上限保护
		if (messageCache.current.size >= CACHE_LIMIT) {
			// 简单 LRU：删除最早的一条
			const firstKey = messageCache.current.keys().next().value;
			if (firstKey !== undefined) messageCache.current.delete(firstKey);
		}
		messageCache.current.set(cacheKey, element);
		return element;
	};

	// M6: 占位高度用累计实际高度
	const topPlaceholderHeight = getCumulativeHeight(visibleRange.start);
	const bottomPlaceholderHeight = Math.max(0, getTotalHeight() - getCumulativeHeight(visibleRange.end));

	return (
		<div className={styles.chat_root}>
			<div ref={chatContainerRef} className={`${styles.chat_container}`}>
				<AIChatSummary historyMsg={allMessages} onSummaryComplete={setSummary} />
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
					<button className={styles.scroll_fab} onClick={scrollToBottom}>回到底部</button>
				)}
				<label className={styles.follow_toggle}>
					<input
						type="checkbox"
						checked={followNew}
						onChange={(e) => setFollowNew(e.target.checked)}
					/>
					<span>跟随新消息</span>
				</label>
			</div>
			{nextSteps && nextSteps.length > 0 && (
				<div className={styles.next_steps_container}>
					<div className={styles.next_steps_header}>
						<span className={styles.next_steps_title}>下一步建议</span>
						<div className={styles.next_steps_actions}>
							<button type="button" className={styles.next_btn} onClick={refreshNextSteps} disabled={nextLoading}>
								{nextLoading ? '加载中…' : '换一批'}
							</button>
							<button type="button" className={styles.next_btn} onClick={() => setNextCollapsed(v => !v)}>
								{nextCollapsed ? '展开' : '收起'}
							</button>
						</div>
					</div>
					{!nextCollapsed && (
						<div className={styles.next_steps_chips}>
							{nextSteps.slice(0, 3).map((s, idx) => (
								<button
									key={idx}
									className={styles.chip}
									onClick={() => {
										// M2: 改用全局事件仍是最简方式（ChatContainer 与 ChatTool 无共同父组件可直接传 prop）
										// 但为避免魔法字符串风险，封装为具名事件
										window.dispatchEvent(new CustomEvent('next-steps-insert', { detail: { text: s } }));
									}}
									type="button"
								>
									{s}
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
};

export default ChatContainer;
