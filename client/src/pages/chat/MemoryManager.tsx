import { Button, Modal, Switch } from 'antd';

import styles from './index.module.less';
import type { AssistantMemoryItem } from './type';

interface MemoryManagerProps {
	open: boolean;
	memories: AssistantMemoryItem[];
	loading: boolean;
	memoryEnabled: boolean;
	onClose: () => void;
	onMemoryEnabledChange: (checked: boolean) => void;
	onDelete: (content: string) => void;
}

const MemoryManager = ({ open, memories, loading, memoryEnabled, onClose, onMemoryEnabledChange, onDelete }: MemoryManagerProps) => (
	<Modal title="AI 记忆管理" open={open} onCancel={onClose} footer={null} width={640}>
		<div className={styles.memoryHeader}><span>关闭后，AI 本轮请求不会读取或写入长期记忆。</span><Switch checked={memoryEnabled} onChange={onMemoryEnabledChange} /></div>
		<div className={styles.memoryList}>
			{loading ? <div className={styles.memoryEmpty}>正在读取记忆...</div> : memories.length === 0 ? <div className={styles.memoryEmpty}>暂无长期记忆</div> : memories.map(item => <div className={styles.memoryItem} key={item.id}><div><strong>{item.category || 'memory'}</strong><span>{item.content}</span></div><Button size="small" danger onClick={() => onDelete(item.content)}>删除</Button></div>)}
		</div>
	</Modal>
);

export default MemoryManager;
