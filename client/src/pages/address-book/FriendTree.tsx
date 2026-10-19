import { Empty, Tree, Tooltip } from 'antd';
import { useMemo } from 'react';
import type { IFriendGroupItem } from '@/components/CreateGroupChatModal/type';
import { StatusIconList } from '@/assets/icons';
import ImageLoad from '@/components/ImageLoad';
import styles from './index.module.less';

export function FriendTree({
	friendList,
	query,
	onSelect
}: {
	friendList: IFriendGroupItem[];
	query: string;
	onSelect: (id: number) => void;
}) {
	const treeData = useMemo(() => {
		const keyword = query.trim().toLocaleLowerCase();
		const matches = (...values: (string | undefined)[]) =>
			!keyword || values.some(value => value?.toLocaleLowerCase().includes(keyword));
		return friendList
			.map(group => ({
				...group,
				friend: group.friend.filter(friend => matches(friend.remark, friend.username))
			}))
			.filter(group => !keyword || group.friend.length > 0)
			.map(group => {
				return {
					title: (
						<span>
							{group.name}&nbsp;&nbsp;&nbsp;&nbsp;{group.online_counts}/{group.friend.length}
						</span>
					),
					key: `group-${group.name}`,
					selectable: false,
					children: group.friend.map(friend => ({
						title: (
							<div className={styles.nodeContent}>
								<ImageLoad src={friend.avatar} />
								<span>{friend.remark}</span>
								<span className={styles.friendStatus}>
									<Tooltip
										placement="bottomLeft"
										title={
											friend.online_status === 'offline'
												? StatusIconList[1].text
												: StatusIconList[0].text
										}
										arrow={false}
									>
										<span aria-hidden="true" style={{ color: friend.online_status === 'offline' ? '#9ca9b8' : '#389e64' }}>●</span>
									</Tooltip>
								</span>
							</div>
						),
						key: String(friend.id),
						isLeaf: true
					}))
				};
			});
	}, [friendList, query]);
	return treeData.length ? (
		<div className={styles.friendTree}>
			<Tree.DirectoryTree
				treeData={treeData}
				icon={null}
				showIcon={false}
				onSelect={(_keys, info) => {
					if (info.node.isLeaf) onSelect(Number(info.node.key));
				}}
			/>
		</div>
	) : (
		<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
	);
}
