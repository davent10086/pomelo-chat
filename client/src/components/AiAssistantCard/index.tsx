import React from 'react';
import ImageLoad from '@/components/ImageLoad';
import yosPersona from '@/prompt/yos.md?raw';
import { setAiPersona } from '@/utils/ai-persona';
import styles from '@/pages/address-book/index.module.less';
import type { IFriendInfo } from '@/pages/address-book/type';

interface Props {
  userId: number;
  onChooseChat: (friend: IFriendInfo) => void;
  // 可选覆盖文本与头像
  name?: string;
  desc?: string;
  avatarUrl?: string;
}

const AiAssistantCard: React.FC<Props> = ({ userId, onChooseChat, name = '朝武芳乃', desc = '和我聊聊天吧～', avatarUrl }) => {
  const avatar =
    avatarUrl ?? (typeof window !== 'undefined' ? window.location.origin : '') + '/Tomotake Yoshino.jpg';

  const handleClick = () => {
    // 写入人设到 localStorage 供聊天页读取
    setAiPersona(name, yosPersona);

    const aiFriend: IFriendInfo = {
      friend_id: -1,
      friend_user_id: -100,
      online_status: 'online',
      remark: name,
      group_id: 0,
      group_name: '内置',
      room: `ai_${userId}`,
      unread_msg_count: 0,
      username: 'ai-assistant',
      avatar: avatar,
      phone: '',
      name: name,
      signature: '……请多关照，我是朝武芳乃。'
    } as IFriendInfo;

    onChooseChat(aiFriend);
  };

  return (
    <div className={styles.aiAssistant} onClick={handleClick}>
      <ImageLoad src={avatar} />
      <div className={styles.info}>
        <span className={styles.name}>{name}</span>
        <span className={styles.desc}>{desc}</span>
      </div>
      <span className={styles.badge}>角色</span>
    </div>
  );
};

export default AiAssistantCard;
