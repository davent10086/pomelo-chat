import { Button, Tabs, type TabsProps } from 'antd';
import { NotificationOutlined } from '@ant-design/icons';
import { useState } from 'react';
import type { IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import CreateGroupChatModal from '@/components/CreateGroupChatModal';
import ImageLoad from '@/components/ImageLoad';
import { TabType } from './type';
import styles from './index.module.less';

export function GroupDetails({
	curGroupChatInfo,
	handleChooseChat
}: {
	curGroupChatInfo: IGroupChatInfo;
	handleChooseChat: (group: IGroupChatInfo) => void;
}) {
	const [openCreateModal, handleCreateModal] = useState(false);
	const infoItems: TabsProps['items'] = [
		{
			key: TabType.FRIEND,
			label: '首页',
			children: (
				<div className={styles.homePage}>
					<span>
						<b> 群主：</b>
						{curGroupChatInfo?.creator_username}
					</span>
					<span>
						<b> 群创建时间：</b> 本群创建于
						{curGroupChatInfo?.created_at.split('.')[0].replace('T', ' ')}
					</span>
					<span>
						<b> 群人数：</b>
						{curGroupChatInfo?.members.length}
					</span>
				</div>
			)
		},
		{
			key: TabType.GROUP_CHAT,
			label: '成员',
			children: (
				<div className={styles.memberTable}>
					<div className={styles.tableTitle}>
						<li> 用户名 </li>
						<li> 群昵称 </li>
						<li> 加入时间 </li>
						<li> 最后发言时间 </li>
					</div>
					<div className={styles.tableContent}>
						{curGroupChatInfo?.members.map(item => {
							return (
								<div className={styles.tableItem} key={item.user_id}>
									<li>{item.username}</li>
									<li>{item.nickname}</li>
									<li>{item.created_at.split('.')[0].replace('T', ' ')}</li>
									<li>{item.lastMessageTime?.split('.')[0].replace('T', '') || '暂无'}</li>
								</div>
							);
						})}
					</div>
				</div>
			)
		}
	];

	return (
		<>
			<div className={styles.infoModal} role="region" aria-label="群聊详情">
				<div className={styles.infoContainerHead}>
					<div className={styles.avatar}>
						<ImageLoad src={curGroupChatInfo.avatar} />
					</div>
					<div className={styles.info}>
						<div className={styles.username}>{curGroupChatInfo.name}</div>
						<div className={styles.signature}>
							<NotificationOutlined />{' '}
							{curGroupChatInfo.announcement ? curGroupChatInfo.announcement : '暂无公告'}
						</div>
					</div>
				</div>
				<div className={styles.infoContainerBody}>
					<Tabs centered defaultActiveKey="1" items={infoItems}></Tabs>
				</div>
				<div className={styles.btns}>
					<Button onClick={() => handleCreateModal(true)}> 邀请好友 </Button>
					<Button
						type="primary"
						onClick={() => {
							handleChooseChat(curGroupChatInfo);
						}}
					>
						发送消息
					</Button>
				</div>
			</div>
			{openCreateModal && (
				<CreateGroupChatModal
					openmodal={openCreateModal}
					groupChatInfo={curGroupChatInfo}
					handleModal={handleCreateModal}
					type="invite"
				/>
			)}
		</>
	);
}
