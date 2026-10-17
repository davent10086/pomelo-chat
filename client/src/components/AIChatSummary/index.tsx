import { Button, Modal, Spin, message } from 'antd';
import React, { useEffect, useRef, useState } from 'react';

import { streamAgentReply } from '@/utils/assistant';
import { sanitizeAiContent } from '@/utils/sanitize';

import styles from './index.module.less';
import { IAIChatSummaryProps } from './type';

const AIChatSummary = (props: IAIChatSummaryProps) => {
	const { historyMsg, onSummaryComplete } = props;
	const [loading, setLoading] = useState(false);
	const [summary, setSummary] = useState('');
	const summaryRef = useRef('');
	const [isModalVisible, setIsModalVisible] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const streamingRef = useRef<boolean>(false);
	useEffect(
		() => () => {
			abortRef.current?.abort();
			abortRef.current = null;
			streamingRef.current = false;
		},
		[]
	);

	// 与 AI 聊天共用 Agent SSE 协议。
	const summarizeChat = async () => {
		if (!historyMsg || historyMsg.length === 0) {
			message.warning('暂无聊天记录可总结');
			return;
		}

		const controller = new AbortController();
		abortRef.current?.abort();
		abortRef.current = controller;
		setLoading(true);
		try {
			// 构造聊天记录文本
			const chatText = historyMsg
				.map(msg => `${msg.sender_name || '用户'}: ${msg.content}`)
				.join('\n');

			// 构造提示词
			const prompt = '请为提供的聊天记录生成一个简洁的总结，包括主要讨论话题和关键信息点。';
			// 启动流式请求
			streamingRef.current = true;
			setSummary('');
			summaryRef.current = '';
			setIsModalVisible(true);

			const result = await streamAgentReply(
				prompt,
				undefined,
				{
					currentChatType: 'assistant',
					recentMessagesText: chatText.slice(-20000),
					memoryEnabled: false,
					readOnly: true
				},
				text => {
					if (abortRef.current !== controller || controller.signal.aborted) return;
					summaryRef.current = text;
					setSummary(text);
				},
				undefined,
				controller.signal
			);
			if (abortRef.current !== controller || controller.signal.aborted) return;
			summaryRef.current = sanitizeAiContent(result.summary || result.content);
			setSummary(summaryRef.current);

			// 完成
			streamingRef.current = false;
			if (summaryRef.current) {
				onSummaryComplete(summaryRef.current);
			} else {
				onSummaryComplete('');
			}
		} catch (error: unknown) {
			if (abortRef.current !== controller) return;
			const err = error as { name?: string; message?: string } | undefined;
			if (err?.name === 'AbortError') {
				message.info('已取消生成');
			} else {
				const errorMsg = err?.message || 'AI总结失败,请稍后重试';
				message.error(errorMsg);
			}
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null;
				streamingRef.current = false;
				setLoading(false);
			}
		}
	};

	const stopSummarize = () => {
		if (abortRef.current) {
			abortRef.current.abort();
			streamingRef.current = false;
		}
	};

	const handleOk = () => {
		setIsModalVisible(false);
	};

	const handleCancel = () => {
		setIsModalVisible(false);
	};

	return (
		<>
			{streamingRef.current ? (
				<Button danger onClick={stopSummarize} className={styles.summaryButton}>
					停止生成
				</Button>
			) : (
				<Button
					type="primary"
					onClick={summarizeChat}
					loading={loading}
					className={styles.summaryButton}
				>
					总结聊天
				</Button>
			)}

			<Modal
				title="聊天记录总结"
				open={isModalVisible}
				onOk={handleOk}
				onCancel={handleCancel}
				width={600}
				okText="确定"
				cancelText="关闭"
			>
				<Spin spinning={loading || streamingRef.current}>
					<div className={styles.summaryContent}>{summary}</div>
				</Spin>
			</Modal>
		</>
	);
};

export default AIChatSummary;
