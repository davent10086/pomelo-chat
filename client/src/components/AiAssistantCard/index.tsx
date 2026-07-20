import React from 'react';
import ImageLoad from '@/components/ImageLoad';
import styles from '@/pages/address-book/index.module.less';
import { AI_USERNAME, getAiAvatar } from '@/hooks/useAiAssistant';

import type { IFriendInfo } from '@/pages/address-book/type';
interface Props {
  userId: number;
  onChooseChat: (friend: IFriendInfo) => void;
  // 可选覆盖文本与头像
  name?: string;
  desc?: string;
  avatarUrl?: string;
}

// AI助手卡片组件，用于在地址簿中显示AI助手的信息
const AiAssistantCard: React.FC<Props> = ({ userId, onChooseChat, name = 'AI助手', desc = '有什么可以帮你的吗？', avatarUrl }) => {
  // 计算头像URL，如果未提供avatarUrl，则使用统一默认头像
  const avatar = avatarUrl ?? getAiAvatar();

  // 点击卡片时的处理函数
  const handleClick = () => {
    // 构建AI助手的信息对象
    const aiFriend: IFriendInfo = {
      friend_id: -1,
      friend_user_id: -100,
      online_status: 'online',
      remark: name,
      group_id: 0,
      group_name: '内置',
      room: `ai_${userId}`,
      unread_msg_count: 0,
      username: AI_USERNAME,
      avatar: avatar,
      phone: '',
      name: name,
      signature: '我是AI助手，有什么可以帮你的吗？'
    } as IFriendInfo;

    // 调用onChooseChat函数，选择与AI助手聊天
    onChooseChat(aiFriend);
  };

  // 渲染AI助手卡片
  return (
    <div className={styles.aiAssistant} onClick={handleClick}>
      <ImageLoad src={avatar} />
      <div className={styles.info}>
        <span className={styles.name}>{name}</span>
        <span className={styles.desc}>{desc}</span>
      </div>
      <span className={styles.badge}>AI</span>
    </div>
  );
};

export default AiAssistantCard;
