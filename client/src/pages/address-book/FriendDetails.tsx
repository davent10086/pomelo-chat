import { Button, Form, Input, Select } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useEffect } from 'react';
import type { IFriendInfo, IFriendInfoForm, IFriendGroupListItem } from './type';
import ImageLoad from '@/components/ImageLoad';
import styles from './index.module.less';

export function FriendDetails({
	curFriendInfo,
	groupList,
	handleChooseChat,
	onSave
}: {
	curFriendInfo: IFriendInfo;
	groupList: IFriendGroupListItem[];
	handleChooseChat: (friend: IFriendInfo) => void;
	onSave: (values: IFriendInfoForm) => Promise<boolean>;
}) {
	const [friendInfoFormInstance] = Form.useForm<IFriendInfoForm>();
	useEffect(() => {
		friendInfoFormInstance.setFieldsValue({
			username: curFriendInfo.username,
			name: curFriendInfo.name,
			remark: curFriendInfo.remark,
			group: curFriendInfo.group_id
		});
	}, [curFriendInfo, friendInfoFormInstance]);
	const updateFriend = async () => {
		try {
			await onSave(await friendInfoFormInstance.validateFields());
		} catch {
			/* Form displays validation errors beside the fields. */
		}
	};
	return (
		<div className={styles.infoModal} role="region" aria-label="好友资料">
			<div className={styles.infoContainerHead}>
				<div className={styles.avatar}>
					<ImageLoad src={curFriendInfo.avatar} />
				</div>
				<div className={styles.info}>
					<div className={styles.username}>{curFriendInfo.username}</div>
					<div className={styles.signature}>
						<EditOutlined />{' '}
						{curFriendInfo.signature ? curFriendInfo.signature : '暂无个性签名'}
					</div>
				</div>
			</div>
			<div className={styles.changeContainer}>
				<Form name="friendInfoForm" form={friendInfoFormInstance}>
					<Form.Item label="账号" name="username">
						<Input readOnly />
					</Form.Item>
					<Form.Item label="昵称" name="name">
						<Input readOnly />
					</Form.Item>
					<Form.Item label="备注" name="remark">
						<Input placeholder="请输入好友备注" />
					</Form.Item>
					<Form.Item label="分组" name="group">
						<Select
							size="small"
							notFoundContent="暂无分组"
							placeholder="请选择分组"
							options={groupList.map(item => {
								return {
									label: item.name,
									value: item.id
								};
							})}
						/>
					</Form.Item>
				</Form>
			</div>
			<div className={styles.btns}>
				<Button
					onClick={() => {
						updateFriend();
					}}
				>
					保存信息
				</Button>
				<Button
					type="primary"
					onClick={() => {
						handleChooseChat(curFriendInfo);
					}}
				>
					发送消息
				</Button>
			</div>
		</div>
	);
}
