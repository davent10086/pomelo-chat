import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useAiAssistant } from '@/hooks/useAiAssistant';
import type { IMessageItem } from '@/components/MessageShow/type';
import type { DesktopAuth, DesktopChat, DesktopSnapshot } from '@/desktop/bridge';
import { AssistantMotion, type MotionPhase } from '@/desktop/motion';
import { sessionStorageKey } from '@/utils/storage';
import type { IMessageListItem } from '@/components/ChatTool/type';
import { RequestScope } from '@/utils/request-scope';
import MessageDraft from '@/pages/chat/MessageDraft';
import './style.less';

interface DisplayMessage {
	id: string; role: 'user' | 'assistant'; text: string; source: string;
	status?: 'generating' | 'completed' | 'stopped' | 'error'; suggestions?: string[]; draft?: string;
}

function DesktopSession({ auth, chat, expanded, onComplete }: {
	auth: DesktopAuth; chat: DesktopChat | null; expanded: boolean; onComplete(): void;
}) {
	const { generateReply } = useAiAssistant(auth.user);
	const [associated, setAssociated] = useState(false);
	const [input, setInput] = useState('');
	const [messages, setMessages] = useState<DisplayMessage[]>([]);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState('');
	const [recipients, setRecipients] = useState<IMessageListItem[]>([]);
	const [request] = useState(() => new RequestScope());
	const list = useRef<HTMLDivElement>(null);
	const active = useRef<AbortController>();
	const live = useRef(true);
	const chain = useRef(0);
	const history = useRef<IMessageItem[]>([]);
	const scope = associated && chat ? `${chat.type}:${chat.room}` : 'standalone';
	const completion = useRef(onComplete);
	completion.current = onComplete;
	useLayoutEffect(() => { chain.current++; history.current = []; }, [scope]);
	useEffect(() => {
		live.current = true;
		request.resume();
		return () => { live.current = false; active.current?.abort(); request.dispose(); };
	}, [request]);
	const loadRecipients = async () => {
		try {
			const response = await request.get<IMessageListItem[]>('/message/chat_list');
			if (live.current) setRecipients(response.data.data.filter(item => !!item.room && !item.room.startsWith('ai_')));
		} catch {
			if (live.current) setNotice('无法加载收件人，请点击刷新收件人重试');
		}
	};
	useEffect(() => {
		if (expanded && list.current) list.current.scrollTop = list.current.scrollHeight;
	}, [messages, expanded]);
	const copy = async (text: string) => {
		try { await navigator.clipboard.writeText(text); setNotice('已复制'); }
		catch { setNotice('复制失败，请选中文字后复制'); }
	};
	const send = async (text = input) => {
		text = text.trim();
		if (!text || active.current || text.length > 8000) return;
		const controller = new AbortController();
		active.current = controller;
		const requestChain = chain.current;
		const context = associated && chat ? { ...chat } : null;
		const source = context?.name || '独立对话';
		const userId = crypto.randomUUID(), replyId = crypto.randomUUID();
		setBusy(true); setNotice('');
		setMessages(previous => [...previous,
			{ id: userId, role: 'user', text, source },
			{ id: replyId, role: 'assistant', text: '', source, status: 'generating' }
		]);
		const item = (content: string, senderId: number): IMessageItem => ({
			sender_id: senderId, receiver_id: auth.user.id, room: context?.room || `desktop_${auth.user.id}`,
			content, avatar: '', type: 'text', file_size: null, created_at: new Date()
		});
		try {
			const result = await generateReply(text, history.current, {
				room: context?.room, currentChatType: context?.type || 'assistant',
				currentReceiverId: context?.receiverId, memoryEnabled: false,
				throwOnError: true, signal: controller.signal,
				onDelta: value => {
					if (!live.current || controller.signal.aborted) return;
					setMessages(previous => previous.map(message => message.id === replyId ? { ...message, text: value } : message));
				}
			});
			if (!live.current || controller.signal.aborted) return;
			setMessages(previous => previous.map(message => message.id === replyId
				? { ...message, text: result.text, status: 'completed', suggestions: result.replySuggestions, draft: result.draftMessage } : message));
			if (result.draftMessage) void loadRecipients();
			if (requestChain === chain.current) history.current = [...history.current, item(text, auth.user.id), item(result.text, 0)].slice(-20);
			setInput(previous => previous.trim() === text ? '' : previous);
			completion.current();
		} catch (error) {
			if (!live.current) return;
			const stopped = controller.signal.aborted;
			setMessages(previous => previous.map(message => message.id === replyId ? {
				...message, status: stopped ? 'stopped' : 'error',
				text: stopped ? (message.text || '已停止生成') : `${message.text ? `${message.text}\n\n` : ''}${error instanceof Error ? error.message : '连接失败，请重试。'}`
			} : message));
		} finally {
			if (active.current === controller) active.current = undefined;
			if (live.current) setBusy(false);
		}
	};
	return <div className="assistant-content">
		<div className="assistant-context">
			<label><input type="checkbox" checked={associated} onChange={event => setAssociated(event.target.checked)} />关联当前聊天</label>
			<span title={associated ? chat?.name : undefined}>{associated ? chat ? `当前：${chat.name}` : '请在主窗口选择聊天' : '独立对话'}</span>
		</div>
		<div className="assistant-shortcuts">
			{(!associated || !chat) && <span className="assistant-shortcut-hint">{!associated ? "关联聊天后使用" : "请先选择聊天"}</span>}
			<button disabled={!associated || !chat || busy} onClick={() => void send('请总结当前聊天的重点。')}>总结聊天</button>
			<button disabled={!associated || !chat || busy} onClick={() => void send('根据当前聊天，给我几个合适的回复建议，仅提供建议。')}>回复建议</button>
		</div>
		<div className={`assistant-messages ${!messages.length ? 'is-empty' : ''}`} ref={list} aria-live="polite" aria-relevant="additions">
			{!messages.length && <div className="assistant-welcome"><img src="/ai-assistant.svg" alt="" /><h2>有什么可以帮你？</h2><p>聊个想法，或关联当前聊天<br />一起整理重点和回复思路。</p><div className="assistant-starters">{["帮我润色一句话", "帮我梳理一个想法"].map(prompt => <button type="button" key={prompt} onClick={() => { setInput(prompt + "："); requestAnimationFrame(() => list.current?.parentElement?.querySelector<HTMLTextAreaElement>("textarea")?.focus()); }}>{prompt}<span aria-hidden="true">↗</span></button>)}</div></div>}
			{messages.map(message => <article key={message.id} className={`assistant-message ${message.role}`}>
				<div className="message-source">{message.role === 'assistant' ? 'AI 助手' : '你'} · {message.source}</div>
				<div className="message-text">{message.text || <span className="thinking" aria-label="正在思考"><i /><i /><i /></span>}</div>
				{message.status === 'stopped' && message.text !== '已停止生成' && <small>已停止生成</small>}
				{message.status === 'completed' && <button className="copy-button" onClick={() => void copy(message.text)}>复制回答</button>}
				{message.status === 'completed' && message.draft && <div className="desktop-message-draft">
					<MessageDraft draft={message.draft} conversations={recipients} />
					<button className="copy-button" onClick={() => void loadRecipients()}>刷新收件人</button>
				</div>}
				{message.suggestions?.map((suggestion, index) => <button className="reply-suggestion" key={index} onClick={() => void copy(suggestion)}>{suggestion}<span>复制</span></button>)}
			</article>)}
		</div>
		<form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
			<textarea aria-label="向 AI 助手提问" placeholder="问点什么…" value={input} maxLength={8000}
				onChange={event => setInput(event.target.value)} onKeyDown={event => {
					if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
				}} />
			<div><span role="status">{notice || (busy ? '正在生成…' : 'Enter 提问 · Shift 换行')}</span>
				{busy ? <button key="stop" type="button" onClick={event => { event.preventDefault(); active.current?.abort(); }}>停止</button>
					: <button key="send" type="submit" aria-label="发送提问" disabled={!input.trim()}>提问</button>}
			</div>
		</form>
	</div>;
}

export default function DesktopAssistant() {
	const bridge = window.pomeloDesktop;
	const [snapshot, setSnapshot] = useState<DesktopSnapshot>({ revision: -1, auth: null, chat: null });
	const [phase, setPhase] = useState<MotionPhase>('collapsed');
	const [ready, setReady] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [unread, setUnread] = useState(false);
	const [windowError, setWindowError] = useState('');
	const panel = useRef<HTMLDivElement>(null);
	const reduced = useRef(false);
	const animation = useRef<Animation>();
	const motion = useRef<AssistantMotion>();
	const revision = useRef(-1);
	const authToken = useRef('');
	const authIdentity = useRef('');
	const pointer = useRef<{ x: number; y: number; distance: number; moved: boolean }>();
	if (!motion.current && bridge) motion.current = new AssistantMotion({
		resize: async (expanded, ticket) => {
			const bounds = await bridge.resizeAssistant(expanded, ticket, authToken.current);
			if (panel.current) panel.current.style.transformOrigin = bounds.origin;
		},
		phase: setPhase,
		error: () => setWindowError('窗口动画未完成，请再次点击。'),
		animate: expanded => {
			animation.current?.cancel();
			const element = panel.current;
			if (!element) return { finished: Promise.resolve(), cancel: () => undefined };
			const hidden = reduced.current ? { opacity: 0 } : { opacity: 0, transform: 'translateX(-12px)' };
			const visible = { opacity: 1, transform: 'translateX(0)' };
			const next = element.animate(expanded ? [hidden, visible] : [visible, hidden], {
				duration: reduced.current ? 80 : expanded ? 240 : 180, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both'
			});
			animation.current = next;
			return { finished: next.finished.then(() => undefined), cancel: () => next.cancel() };
		}
	});
	useLayoutEffect(() => {
		document.documentElement.classList.add('desktop-assistant-surface');
		return () => document.documentElement.classList.remove('desktop-assistant-surface');
	}, []);
	useEffect(() => {
		const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
		const update = () => { reduced.current = preference.matches; };
		update(); preference.addEventListener('change', update);
		return () => preference.removeEventListener('change', update);
	}, []);
	useEffect(() => {
		if (!bridge) return;
		let disposed = false;
		const apply = (value: DesktopSnapshot) => {
			if (disposed || value.revision <= revision.current) return;
			revision.current = value.revision;
			const identity = value.auth ? `${value.auth.user.id}:${value.auth.token}` : '';
			if (authIdentity.current !== identity) {
				motion.current?.reset(); setUnread(false); setWindowError('');
				authToken.current = value.auth?.token || '';
				authIdentity.current = identity;
			}
			if (value.auth) {
				sessionStorage.setItem(`${sessionStorageKey}authToken`, JSON.stringify(value.auth.token));
				sessionStorage.setItem(`${sessionStorageKey}userInfo`, JSON.stringify(value.auth.user));
			} else {
				sessionStorage.removeItem(`${sessionStorageKey}authToken`);
				sessionStorage.removeItem(`${sessionStorageKey}userInfo`);
			}
			setSnapshot(value); setReady(true);
		};
		const unsubscribe = bridge.subscribe(apply);
		void bridge.getSnapshot().then(apply).catch(() => setWindowError('无法连接桌面主进程'));
		return () => { disposed = true; unsubscribe(); motion.current?.reset(); };
	}, [bridge]);
	const expanded = phase !== 'collapsed';
	const toggle = () => {
		if (!motion.current || pointer.current?.moved) return;
		const next = !motion.current.targetExpanded;
		if (next) setUnread(false);
		setWindowError('');
		void motion.current.setExpanded(next);
	};
	const beginDrag = (event: PointerEvent<HTMLElement>) => {
		if (event.button !== 0 || (event.target as HTMLElement).closest('button:not(.assistant-ball)')) return;
		pointer.current = { x: event.screenX, y: event.screenY, distance: 0, moved: false };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const moveDrag = (event: PointerEvent<HTMLElement>) => {
		const previous = pointer.current;
		if (!previous) return;
		const dx = event.screenX - previous.x, dy = event.screenY - previous.y;
		previous.distance += Math.abs(dx) + Math.abs(dy);
		if (previous.distance > 4) { previous.moved = true; setDragging(true); bridge?.dragAssistant(dx, dy); }
		previous.x = event.screenX; previous.y = event.screenY;
	};
	const endDrag = (event: PointerEvent<HTMLElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		setDragging(false);
		// Preserve the moved flag until the click event has been dispatched.
		setTimeout(() => { pointer.current = undefined; }, 0);
	};
	if (!bridge) return <div className="assistant-unavailable">请通过 pnpm dev:desktop 打开桌面助手。</div>;
	if (!ready || !snapshot.auth) return null;
	return <div className={`assistant-root ${dragging ? 'is-dragging' : ''}`} data-phase={phase}>
		{phase === 'collapsed' && <div className="assistant-ball-wrap" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag}
			onPointerCancel={endDrag} onClick={toggle}>
			<button className={`assistant-ball ${unread ? 'has-unread' : ''}`} title={windowError || '展开 AI 助手'} aria-label="展开 AI 助手">
				<img src="/ai-assistant.svg" alt="" draggable={false} /><strong>AI</strong><span className="assistant-tab-arrow">‹</span>{unread && <span className="unread-dot" />}
			</button>
		</div>}
		<div className="assistant-panel" ref={panel} aria-hidden={!expanded} style={{ visibility: expanded ? 'visible' : 'hidden' }}>
			<header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
				<div><img src="/ai-assistant.svg" alt="" draggable={false} /><span>Pomelo AI</span></div>
				<button aria-label="折叠 AI 助手" title="折叠" onClick={toggle}>›</button>
			</header>
			{windowError && <div role="alert" className="assistant-window-error">{windowError}</div>}
			<DesktopSession key={`${snapshot.auth.user.id}:${snapshot.auth.token}`} auth={snapshot.auth} chat={snapshot.chat} expanded={expanded}
				onComplete={() => { if (!motion.current?.targetExpanded) setUnread(true); }} />
		</div>
	</div>;
}
