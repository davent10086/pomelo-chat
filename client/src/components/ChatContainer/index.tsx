import { useEffect, useMemo, useRef, useState } from 'react';

import styles from './index.module.less';
import { IChatContainerProps } from './type';

import AIChatSummary from '@/components/AIChatSummary';
import MessageShow from '@/components/MessageShow';
import { IMessageItem } from '@/components/MessageShow/type';

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
	const messagesWrapRef = useRef<HTMLDivElement>(null); // 包裹消息区域，用于计算相对滚动
	const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });
	const [summary, setSummary] = useState('');
	const [followNew, setFollowNew] = useState<boolean>(true); // 是否跟随新消息到底部
	// 按 message.id 缓存已渲染的消息组件，防止因索引漂移导致重复创建
	const messageCache = useRef<Map<string | number, JSX.Element>>(new Map());
	// 标记用户是否已经滚动到容器底部（用于决定是否自动滚动）
	const isAtBottomRef = useRef<boolean>(true);

	// --- 会话态增强：下一步建议（移动到对话区浮层，不占输入区空间） ---
	const [nextSteps, setNextSteps] = useState<string[]>([]);
	const [nextCollapsed, setNextCollapsed] = useState<boolean>(false);
	const [nextLoading, setNextLoading] = useState<boolean>(false);
	const seedRef = useRef<number>(0);

	// 合并所有消息
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

	const fetchNextStepsFromDeepSeek = async () => {
		const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
		if (!apiKey) throw new Error('no-deepseek-key');
		const prompt = `基于以下最近的对话内容，给出不超过5条"下一步行动建议"，要求：\n1) 中文，简洁，每条不超过30字\n2) 可直接点击作为回复开头或行动声明\n3) 不要编号，按行返回\n\n对话：\n${buildContextText(12)}`;
		const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], stream: false })
		});
		if (!resp.ok) throw new Error(`deepseek error ${resp.status}`);
		const data = await resp.json();
		const text = data?.choices?.[0]?.message?.content || '';
		const lines = text.split('\n').map((s: string) => s.trim().replace(/^[-•\d.\s]+/, '')).filter((s: string) => s.length > 0);
		return lines.slice(0, 5);
	};

	const refreshNextSteps = async () => {
		setNextLoading(true);
		seedRef.current += 1;
		try {
			let items: string[] = [];
			try {
				items = await fetchNextStepsFromDeepSeek();
			} catch {
				items = heuristicNextSteps(3);
			}
			setNextSteps(items.slice(0, 3));
		} finally {
			setNextLoading(false);
		}
	};

	useEffect(() => {
		refreshNextSteps();
	}, [allMessages.length]);

	// 计算可见范围
	useEffect(() => {
		if (!chatContainerRef.current) return;

		const container = chatContainerRef.current;
		const handleScroll = () => {
			// 根据是否接近底部动态调整缓冲区，接近底部时保留更多条目以减少卸载重建导致的闪烁
			const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
			const dynamicBuffer = distanceToBottom <= 100 ? BUFFER_SIZE * 4 : BUFFER_SIZE;
			// 计算相对消息列表顶部的滚动距离，排除头部（如 AI 总结）的高度影响
			const listOffsetTop = messagesWrapRef.current ? messagesWrapRef.current.offsetTop : 0;
			const relativeScrollTop = Math.max(0, container.scrollTop - listOffsetTop);
			// 计算可见范围
			const start = Math.max(0, Math.floor(relativeScrollTop / ITEM_HEIGHT) - dynamicBuffer);
			const end = Math.min(
				allMessages.length,
				start + Math.ceil(container.clientHeight / ITEM_HEIGHT) + dynamicBuffer * 2
			);

			setVisibleRange({ start, end });

			// 判断是否接近底部（容差为 20px），用于决定新消息到达时是否自动滚动到底部
			isAtBottomRef.current = distanceToBottom <= 20;
			// 只要用户不是在底部，就认为当前跟随状态可能被中断（但不自动关掉开关，仅用于显示 FAB）
		};

		container.addEventListener('scroll', handleScroll);
		handleScroll(); // 初始化

		return () => {
			container.removeEventListener('scroll', handleScroll);
		};
	}, [allMessages.length]);

	// 注意：不再在每次消息变更时清空缓存，以减少 DOM 重建带来的闪烁。
	// 缓存按 message.id 保存，保持相同消息的组件复用。若需要处理编辑场景可在此处扩展缓存失效策略。

	// 滚动到底部
	const scrollToBottom = () => {
		if (chatContainerRef.current) {
			// 直接设置 scrollTop，保证不触发额外滚动动画导致重绘闪烁
			chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
		}
	};

	// 生成稳定的 key：优先使用 message.id（如果存在），否则使用 created_at + sender_id + 内容片段作为退路
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

	// 当有新消息时滚动到底部
	useEffect(() => {
		if (newMsg && newMsg.length > 0) {
			// 只有当用户已经在底部且启用跟随时才自动滚动
			if (isAtBottomRef.current && followNew) {
				// 扩大可见范围以确保底部条目先被渲染，减少因虚拟滚动未渲染底部而导致的跳动
				if (chatContainerRef.current) {
					const container = chatContainerRef.current;
					const visibleCount = Math.ceil(container.clientHeight / ITEM_HEIGHT) + BUFFER_SIZE * 4;
					const end = allMessages.length;
					const start = Math.max(0, end - visibleCount);
					// 只有在当前 visibleRange 不包含末尾时才更新，以减少不必要的重渲染
					if (visibleRange.end < end) {
						setVisibleRange({ start, end });
					}
				}

				// 双 requestAnimationFrame 等待 React 渲染并等待浏览器绘制，能更可靠地在渲染完成后滚动到底部，减少闪烁
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						scrollToBottom();
					});
				});
			}
		}
	}, [newMsg, followNew]);

	// 渲染单个消息
	const renderMessage = (message: IMessageItem, index: number) => {
		const cacheKey = getMessageKey(message, index);

		// 尝试从缓存中获取消息组件（以稳定 key 为缓存 key，避免索引变动导致的重复渲染）
		if (messageCache.current.has(cacheKey)) {
			return messageCache.current.get(cacheKey) as JSX.Element;
		}

		// 计算是否显示时间
		const prev = allMessages[index - 1];
		const prevTime = prev ? new Date(prev.created_at).getTime() : 0;
		const curTime = message.created_at ? new Date(message.created_at).getTime() : 0;
		const showTime = index === 0 || (index > 0 && curTime - prevTime > 5 * 60 * 1000);

		const element = (
			<div key={cacheKey} className={styles.chat_item}>
				<MessageShow showTime={showTime} message={message} />
			</div>
		);

		// 缓存消息组件
		messageCache.current.set(cacheKey, element);
		return element;
	};

	return (
		<div className={styles.chat_root}>
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
				<div ref={messagesWrapRef}>
					{/* 顶部占位：未渲染的消息高度 */}
					<div style={{ height: `${visibleRange.start * ITEM_HEIGHT}px` }} />

					{/* 渲染可见消息 */}
					{allMessages.slice(visibleRange.start, visibleRange.end).map((message, index) => {
						const actualIndex = visibleRange.start + index;
						return renderMessage(message, actualIndex);
					})}

					{/* 底部占位：未渲染的剩余消息高度 */}
					<div style={{ height: `${Math.max(0, (allMessages.length - visibleRange.end) * ITEM_HEIGHT)}px` }} />
				</div>
			</div>
			{/* 浮动控制：当不在底部时显示回到底部按钮；总是展示跟随新消息开关 */}
			<div className={styles.fab_container}>
				{!isAtBottomRef.current && (
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
			{/* 下一步建议浮层（不占输入区空间） */}
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