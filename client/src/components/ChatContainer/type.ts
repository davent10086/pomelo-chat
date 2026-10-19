import { IMessageItem } from '@/components/MessageShow/type';

/**
 * 组件用到的其它类型定义
 */
// 给聊天框组件传递的参数类型
export interface IChatContainerProps {
	summarySlot?: HTMLElement | null;
	onAtBottomChange?: (atBottom: boolean) => void;
	onCancelRetry?: (message: IMessageItem) => void;
	onRetry?: (message: IMessageItem) => void;
	historyMsg: IMessageItem[] | undefined;
	newMsg: IMessageItem[] | undefined;
	hasMoreHistory?: boolean;
	onLoadMoreHistory?: () => Promise<void> | void;
	historyLoading?: boolean;
	focusMessageId?: number;
}
