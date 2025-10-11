import { Button, Modal, Spin, message } from 'antd';
import React, { useState } from 'react';

import styles from './index.module.less';
import { IAIChatSummaryProps } from './type';

const AIChatSummary = (props: IAIChatSummaryProps) => {
  const { historyMsg, onSummaryComplete } = props;
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState('');
  const [isModalVisible, setIsModalVisible] = useState(false);

  // 调用DeepSeek API进行聊天记录总结
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

      // 调用DeepSeek API
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          stream: false
        })
      });

      const data = await response.json();
      
      if (data.choices && data.choices.length > 0) {
        const summaryText = data.choices[0].message.content;
        setSummary(summaryText);
        onSummaryComplete(summaryText);
        setIsModalVisible(true);
      } else if (data.error) {
        // 处理DeepSeek API返回的错误
        const errorMessage = data.error.message || 'AI总结失败，请稍后重试';
        message.error(errorMessage);
      } else {
        message.error('AI总结失败，请稍后重试');
      }
    } catch (error: any) {
      // console.error('AI总结出错:', error);
      const errorMsg = error.message || 'AI总结失败,请检查网络连接或API密钥配置';
      message.error(errorMsg);
    } finally {
      setLoading(false);
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
      <Button 
        type="primary" 
        onClick={summarizeChat} 
        loading={loading}
        className={styles.summaryButton}
      >
        AI总结聊天记录
      </Button>
      
      <Modal
        title="聊天记录总结"
        open={isModalVisible}
        onOk={handleOk}
        onCancel={handleCancel}
        width={600}
        okText="确定"
        cancelText="关闭"
      >
        <Spin spinning={loading}>
          <div className={styles.summaryContent}>
            {summary}
          </div>
        </Spin>
      </Modal>
    </>
  );
};

export default AIChatSummary;