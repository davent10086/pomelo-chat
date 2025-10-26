import { Button, Modal, Spin, message } from 'antd';
import React, { useRef, useState } from 'react';

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

  // 流式读取 SSE（DeepSeek 兼容 OpenAI 风格）
  const summarizeChat = async () => {
    if (!historyMsg || historyMsg.length === 0) {
      message.warning('暂无聊天记录可总结');
      return;
    }

    setLoading(true);
    try {
      // 检查是否有API密钥
      const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
      if (!apiKey) {
        message.error('请配置DeepSeek API密钥(VITE_DEEPSEEK_API_KEY)');
        setLoading(false);
        return;
      }

      // 构造聊天记录文本
      const chatText = historyMsg.map(msg => 
        `${msg.sender_name || '用户'}: ${msg.content}`
      ).join('\n');

      // 构造提示词
      const prompt = `请为以下聊天记录生成一个简洁的总结，包括主要讨论话题和关键信息点：\n\n${chatText}`;
      // 启动流式请求
      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = true;
  setSummary('');
  summaryRef.current = '';
      setIsModalVisible(true);

      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'user', content: prompt }
          ],
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        // fallback：若不支持流或出错，尝试非流模式
        const nonStream = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            stream: false
          })
        });
        const data = await nonStream.json();
        if (data.choices && data.choices.length > 0) {
          const summaryText = data.choices[0].message.content;
          setSummary(summaryText);
          onSummaryComplete(summaryText);
        } else {
          const errorMessage = data?.error?.message || 'AI总结失败，请稍后重试';
          throw new Error(errorMessage);
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let done = false;
      let buffer = '';

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // 保留最后一行（可能是半截）
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.replace(/^data:\s*/, '');
            if (dataStr === '[DONE]') {
              done = true;
              break;
            }
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed?.choices?.[0]?.delta?.content
                ?? parsed?.choices?.[0]?.message?.content
                ?? '';
              if (delta) {
                // 逐步更新
                setSummary(prev => {
                  const next = prev + delta;
                  summaryRef.current = next;
                  return next;
                });
              }
            } catch {
              /* 忽略解析错误的分片 */
            }
          }
        }
      }

      // 完成
      streamingRef.current = false;
      abortRef.current = null;
      if (summaryRef.current) {
        onSummaryComplete(summaryRef.current);
      } else {
        onSummaryComplete('');
      }
    } catch (error: unknown) {
      const err = error as { name?: string; message?: string } | undefined;
      if (err?.name === 'AbortError') {
        message.info('已取消生成');
      } else {
        const errorMsg = err?.message || 'AI总结失败,请检查网络连接或API密钥配置';
        message.error(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  const stopSummarize = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      streamingRef.current = false;
      abortRef.current = null;
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
          AI总结聊天记录
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
          <div className={styles.summaryContent}>
            {summary}
          </div>
        </Spin>
      </Modal>
    </>
  );
};

export default AIChatSummary;