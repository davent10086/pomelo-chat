import { Button } from 'antd';
import type { ActionStatus } from '@/hooks/useAiAssistant';
import styles from './index.module.less';

export const actionStatusLabels: Record<ActionStatus['status'], string> = {
	pending: '待确认',
	executing: '执行中',
	completed: '已完成',
	cancelled: '已取消',
	expired: '已过期'
};

interface ActionControlsProps {
	status: ActionStatus['status'];
	busy: boolean;
	confirmLabel: string;
	queryLabel?: string;
	canConfirm?: boolean;
	showStatus?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	onQuery: () => void;
}

export const ActionControls = ({
	status,
	busy,
	confirmLabel,
	queryLabel = '查询结果／重试',
	canConfirm = true,
	showStatus = false,
	onConfirm,
	onCancel,
	onQuery
}: ActionControlsProps) => (
	<div className={styles.actionControls}>
		{showStatus && <span>{actionStatusLabels[status]}</span>}
		<Button
			size="small"
			type="primary"
			disabled={busy || status !== 'pending' || !canConfirm}
			loading={busy}
			onClick={onConfirm}
		>
			{confirmLabel}
		</Button>
		<Button size="small" onClick={onQuery} disabled={busy}>
			{queryLabel}
		</Button>
		<Button size="small" disabled={busy || status !== 'pending'} onClick={onCancel}>
			取消
		</Button>
	</div>
);
