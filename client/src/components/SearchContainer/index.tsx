import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Dropdown, Input } from 'antd';
import { useState } from 'react';

import styles from './index.module.less';

import AddFriendOrGroupModal from '@/components/AddFriendOrGroupModal';
import CreateGroupChatModal from '@/components/CreateGroupChatModal';

const SearchContainer = ({
	query,
	onSearchChange,
	placeholder = '搜索会话或联系人'
}: {
	query?: string;
	onSearchChange?: (value: string) => void;
	placeholder?: string;
}) => {
	const [openAddModal, setAddModal] = useState(false);
	const [openCreateModal, setCreateModal] = useState(false);

	// 控制添加好友 / 群聊的弹窗显隐
	const handleAddModal = (visible: boolean) => {
		setAddModal(visible);
	};
	// 控制创建群聊的弹窗显隐
	const handleCreateModal = (visible: boolean) => {
		setCreateModal(visible);
	};

	return (
		<>
			<div className={styles.searchContainer}>
				{onSearchChange && (
					<div className={styles.searchBox}>
						<Input
							size="small"
							aria-label={placeholder}
							placeholder={placeholder}
							prefix={<SearchOutlined />}
							allowClear
							value={query}
							onChange={event => onSearchChange(event.target.value)}
						/>
					</div>
				)}
				<Dropdown
					trigger={['click']}
					menu={{
						items: [
							{ key: 'add', label: '加好友/加群', onClick: () => handleAddModal(true) },
							{ key: 'create', label: '创建群聊', onClick: () => handleCreateModal(true) }
						]
					}}
				>
					<button type="button" className={styles.addBox} aria-label="添加好友或群聊">
						<PlusOutlined />
					</button>
				</Dropdown>
			</div>
			{
				// 添加好友或群聊弹窗
				openAddModal && (
					<AddFriendOrGroupModal openmodal={openAddModal} handleModal={handleAddModal} />
				)
			}
			{
				// 创建群聊弹窗
				openCreateModal && (
					<CreateGroupChatModal
						openmodal={openCreateModal}
						handleModal={handleCreateModal}
						type={'create'}
					/>
				)
			}
		</>
	);
};

export default SearchContainer;
