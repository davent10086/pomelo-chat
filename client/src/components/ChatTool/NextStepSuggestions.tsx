import { BulbOutlined } from '@ant-design/icons';
import { Button, Popover, Spin } from 'antd';
import { useState } from 'react';
import type { IMessageItem } from '@/components/MessageShow/type';
import { useReplySuggestions } from '@/hooks/useReplySuggestions';
import styles from './index.module.less';

export default function NextStepSuggestions({ messages, scope, onInsert }: {
	messages: IMessageItem[]; scope: string; onInsert(text: string): void;
}) {
	const [open, setOpen] = useState(false);
	const { suggestions, loading, refresh } = useReplySuggestions(messages, { scope, count: 3, maxLength: 30 });
	return <Popover trigger="click" placement="top" open={open}
		onOpenChange={value => {
			setOpen(value);
			if (value && !suggestions.length && !loading && messages.length) void refresh();
		}}
		content={<section className={styles.nextStepsPopover} aria-label="下一步建议">
			<div className={styles.nextStepsHeading}><strong>下一步建议</strong>
				<Button size="small" onClick={() => void refresh()} disabled={loading || !messages.length}>换一批</Button></div>
			<p>根据当前聊天生成，点击填入输入框，由你确认发送。</p>
			{loading ? <div role="status"><Spin size="small" /> 正在生成建议…</div> :
				suggestions.length ? suggestions.map(text => <button type="button" key={text}
					className={styles.nextStepChoice} onClick={() => { onInsert(text); setOpen(false); }}>{text}</button>) :
				<p role="status">暂无聊天记录，先聊几句再试试。</p>}
		</section>}>
		<button type="button" className={styles.assistTool} aria-label="下一步建议" aria-expanded={open}>
			<BulbOutlined aria-hidden="true" /><span>下一步建议</span>
		</button>
	</Popover>;
}
