import type { IMessageItem } from '@/components/MessageShow/type';

export interface IAIChatSummaryProps {
  historyMsg: IMessageItem[];
  onSummaryComplete: (summary: string) => void;
}
