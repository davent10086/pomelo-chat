import { Alert, Button, Drawer, Empty, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import request from '@/utils/request';
import type { ReviewItem, ReviewRange, ReviewResult } from './types';
import styles from './style.module.less';

interface Props {
	room: string;
	name: string;
	onLocate: (id: number) => void;
	onInsertText: (text: string) => void;
}
interface Batch {
	result: ReviewResult;
	answers: Array<{ question: string; items: ReviewItem[]; omittedItems: number }>;
}
const sections = [
	['topics', '讨论主题'], ['decisions', '已经决定'],
	['questions', '待确认问题'], ['actions', '行动事项']
] as const;
const timestamp = new Intl.DateTimeFormat('zh-CN', {
	timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', hour12: false
});
const formatTime = (value: string) => timestamp.format(new Date(value));

export default function ConversationReview({ room, name, onLocate, onInsertText }: Props) {
	const [open, setOpen] = useState(false);
	const [range, setRange] = useState<ReviewRange>({ preset: 'today' });
	const [batches, setBatches] = useState<Batch[]>([]);
	const [active, setActive] = useState(0);
	const [question, setQuestion] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const controllerRef = useRef<AbortController>();
	useEffect(() => () => controllerRef.current?.abort(), [room]);
	const batch = batches[active];
	const cancel = () => {
		controllerRef.current?.abort();
		controllerRef.current = undefined;
		setLoading(false);
	};
	const close = () => { cancel(); setOpen(false); };
	const changeRange = (next: ReviewRange) => {
		cancel(); setRange(next); setBatches([]); setActive(0); setQuestion(''); setError('');
	};
	const run = async (mode: 'new' | 'earlier' | 'ask', prompt?: string) => {
		if (loading) return;
		const previous = batch?.result;
		if (mode !== 'new' && !previous) return;
		const controller = new AbortController();
		controllerRef.current?.abort();
		controllerRef.current = controller;
		setLoading(true); setError('');
		const selectedRange: ReviewRange = previous && mode !== 'new'
			? { preset: 'custom', since: previous.coverage.since, until: previous.coverage.until } : range;
		try {
			const response = await request.post<unknown, ReviewResult>('/assistant/agent/review', {
				room, range: selectedRange,
				beforeId: mode === 'earlier' ? previous?.coverage.nextBeforeId
					: mode === 'ask' && previous?.coverage.newestId ? previous.coverage.newestId + 1 : undefined,
				question: mode === 'ask' ? prompt : undefined
			}, { signal: controller.signal, timeout: 125000 });
			if (controllerRef.current !== controller || controller.signal.aborted) return;
			if (response.data.code !== 200 || !response.data.data)
				throw new Error(response.data.message || '回顾失败，请稍后重试');
			const result = response.data.data;
			if (mode === 'ask') {
				setBatches(items => items.map((item, index) => index === active ? {
					...item, answers: [...item.answers, { question: prompt || '', items: result.answer, omittedItems: result.omittedItems }]
				} : item));
				setQuestion('');
			} else if (mode === 'earlier') {
				setBatches(items => [...items, { result, answers: [] }]);
				setActive(batches.length);
			} else { setBatches([{ result, answers: [] }]); setActive(0); }
		} catch (caught) {
			if (controllerRef.current !== controller || controller.signal.aborted) return;
			const failure = caught as { message?: string };
			setError(failure.message || '回顾失败，请稍后重试');
		} finally {
			if (controllerRef.current === controller) { controllerRef.current = undefined; setLoading(false); }
		}
	};
	const locate = (id: number) => { close(); onLocate(id); };
	const renderItem = (item: ReviewItem, index: number, draft = false) => (
		<li className={styles.item} key={index}>
			<p>{item.text}</p>
			{(item.assignee || item.due) && <p className={styles.meta}>
				{item.assignee ? `负责人：${item.assignee}` : '负责人未明确'}
				{item.due ? ` · 截止：${item.due}` : ' · 截止时间未明确'}
			</p>}
			<div className={styles.sources}>
				{item.sources.map(source => <button type="button" key={source.id}
					onClick={() => locate(source.id)} title={source.content}
					aria-label={`查看来源消息 ${source.id}：${source.sender}`}>
					{source.sender} · {formatTime(source.createdAt)}<span>{source.content}</span>
				</button>)}
			</div>
			{draft ? <Button size="small" onClick={() => { onInsertText(item.text); close(); }}>填入输入框</Button>
				: <Button size="small" disabled={loading} onClick={() => void run('ask',
					`针对以下事项起草一条回复，不擅自承诺时间或事实，只返回可发给对方的正文：${item.text}`)}>起草回复</Button>}
		</li>
	);
	return <>
		<Button className={styles.trigger} onClick={() => setOpen(true)}>帮我跟上</Button>
		<Drawer title={`会话回顾 · ${name}`} open={open} onClose={close} width="min(520px, 100vw)"
			className={styles.drawer} mask={false}>
			<p className={styles.meta}>根据服务端聊天记录整理，结论可核对原文。回顾和提问不会发送消息或保存任务。</p>
			<div className={styles.controls}>
				<label>分析范围<select aria-label="回顾分析范围" value={range.preset}
					onChange={event => changeRange({ preset: event.target.value as ReviewRange['preset'] })}>
					<option value="today">今天</option><option value="week">最近七天</option><option value="custom">自定义日期</option>
				</select></label>
				{range.preset === 'custom' && <>
					<label>开始日期<input type="date" aria-label="回顾开始日期" value={range.since || ''}
						onChange={event => changeRange({ ...range, since: event.target.value })} /></label>
					<label>结束日期<input type="date" aria-label="回顾结束日期" value={range.until || ''}
						onChange={event => changeRange({ ...range, until: event.target.value })} /></label>
				</>}
				<Button type="primary" loading={loading} disabled={range.preset === 'custom' &&
					(!range.since || !range.until || range.since > range.until)} onClick={() => void run('new')}>开始回顾</Button>
				{loading && <Button onClick={cancel}>停止生成</Button>}
			</div>
			<p className={styles.meta}>日期按北京时间计算，自定义范围最多 31 天；每段最多读取 200 条消息。</p>
			{error && <Alert type="error" showIcon message={error} />}
			{loading && <div role="status" className={styles.progress}><Spin size="small" /> 正在读取消息并整理有来源的结论…</div>}
			{batch && <>
				{batches.length > 1 && <label className={styles.batch}>已回顾的分段<select aria-label="回顾分段" value={active}
					disabled={loading} onChange={event => { setActive(Number(event.target.value)); setQuestion(''); }}>
					{batches.map((_, index) => <option key={index} value={index}>第 {index + 1} 段{index === 0 ? '（最新）' : '（更早）'}</option>)}
				</select></label>}
				<div className={styles.coverage} role="status">
					<strong>本段实际覆盖范围</strong>
					<p>{batch.result.coverage.since} 至 {batch.result.coverage.until} · 已读取 {batch.result.coverage.scannedMessages} 条，分析 {batch.result.coverage.analyzedMessages} 条文字消息。</p>
					{batch.result.coverage.oldestMessageAt && <p>{formatTime(batch.result.coverage.oldestMessageAt)} — {formatTime(batch.result.coverage.newestMessageAt!)}</p>}
					<p>快照生成于 {formatTime(batch.result.coverage.capturedAt)}，新消息需重新回顾。</p>
					{batch.result.coverage.skippedMedia > 0 && <p>跳过 {batch.result.coverage.skippedMedia} 条非文字消息，未解析附件内容。</p>}
				</div>
				{batch.result.coverage.hasEarlier && <Alert type="warning" showIcon message="仅分析了部分消息，所选日期内还有更早内容。结论仅适用于本段。" />}
				{batch.result.coverage.contentTruncated && <Alert type="warning" message="部分长消息只分析了前 3000 字，结论可能不完整。" />}
				{batch.result.omittedItems > 0 && <Alert type="warning" message="部分模型结论引用无效，已隐藏；本次结果可能不完整。" />}
				{batch.result.coverage.analyzedMessages === 0 ? <Empty description="本段没有可分析的文字消息" /> : <>
					{sections.map(([key, title]) => <section key={key} className={styles.section}>
						<h3>{title}</h3>
						{batch.result[key].length ? <ul>{batch.result[key].map((item, index) => renderItem(item, index))}</ul>
							: <p className={styles.meta}>本段未提取到有来源支持的条目。</p>}
					</section>)}
					<section className={styles.section}>
						<h3>针对本段提问</h3>
						<p className={styles.meta}>例如：为什么延期？最终采用哪个方案？提问只分析当前分段。</p>
						{batch.answers.map((answer, index) => <div key={index} className={styles.answer}>
							<strong>{answer.question}</strong>
							{answer.omittedItems > 0 && <p>部分结论引用无效，已隐藏；本次回答可能不完整。</p>}
							{answer.items.length ? <ul>{answer.items.map((item, itemIndex) => renderItem(item, itemIndex, true))}</ul>
								: <p>未能从本段消息中找到有来源支持的答案。请补充具体问题或回顾其他分段。</p>}
						</div>)}
						<form onSubmit={event => { event.preventDefault(); if (question.trim()) void run('ask', question.trim()); }}>
							<textarea aria-label="会话回顾追问" maxLength={1500} rows={3} value={question} disabled={loading}
								onChange={event => setQuestion(event.target.value)} />
							<Button htmlType="submit" disabled={loading || !question.trim()}>提问</Button>
						</form>
					</section>
				</>}
				{batch.result.coverage.hasEarlier && active === batches.length - 1 && <Button disabled={loading}
					onClick={() => void run('earlier')}>继续回顾更早消息</Button>}
			</>}
		</Drawer>
	</>;
}
