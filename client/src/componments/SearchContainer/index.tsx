/**
 * 搜索容器组件
 * 
 * 该组件提供搜索功能和添加好友/群聊、创建群聊的入口
 * 包含一个搜索框和一个添加按钮，点击添加按钮会显示下拉菜单
 * 
 * @returns 搜索容器的JSX元素
 */
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Tooltip, Input } from 'antd';
import { useState } from 'react';

import styles from './index.module.less';

import AddFriendOrGroupModal from '@/componments/AddFriendOrGroupModal';
import CreateGroupChatModal from '@/componments/CreateGroupChatModal';

const SearchContainer = () => {
	const [openAddModal, setAddModal] = useState(false);
	const [openCreateModal, setCreateModal] = useState(false);

	/**
	 * 控制添加好友 / 群聊的弹窗显隐
	 * @param visible 弹窗是否显示
	 */
	const handleAddModal = (visible: boolean) => {
		setAddModal(visible);
	};
	
	/**
	 * 控制创建群聊的弹窗显隐
	 * @param visible 弹窗是否显示
	 */
	const handleCreateModal = (visible: boolean) => {
		setCreateModal(visible);
	};
	
	// 添加菜单内容
	const addContent = (
		<ul>
			<li onClick={() => handleAddModal(true)}> 加好友/加群 </li>
			<li onClick={() => handleCreateModal(true)}> 创建群聊 </li>
		</ul>
	);

	return (
		<>
			<div className={styles.searchContainer}>
				<div className={styles.searchBox}>
					<Input size="small" placeholder="搜索" prefix={<SearchOutlined />} />
				</div>
				<Tooltip
					placement="bottomLeft"
					title={addContent}
					arrow={false}
					classNames={{ root: "addContent" }}
				>
					<div className={styles.addBox}>
						<PlusOutlined />
					</div>
				</Tooltip>
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