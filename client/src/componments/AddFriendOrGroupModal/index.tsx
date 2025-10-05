/**
 * 添加好友或群聊的模态框组件
 * 提供搜索和添加好友、搜索和加入群聊的功能
 * @param props - 组件属性
 * @param props.openmodal - 控制模态框显示状态
 * @param props.handleModal - 控制模态框显示隐藏的回调函数
 */
import { SearchOutlined } from '@ant-design/icons';
import { Button,Input,Empty,Modal,Tabs,TabsProps } from 'antd';
import { useState } from 'react';
import {getFriendList,addFriend,getGroupList,addGroup} from './api';

import { IAddFriendOrGroupModalProps, IFriendItem, IGroupItem } from './type';
import ImageLoad from '../ImageLoad';
import { HttpStatus } from '@/utils/constant';
import useShowMessage from '@/hooks/useShowMessage';
import styles from './index.module.less';
import React from 'react';

const AddFriendOrGroupModal = (props: IAddFriendOrGroupModalProps) => {
	const { openmodal, handleModal } = props;

	const showMessage = useShowMessage();
	const [friendList, setFriendList] = useState<IFriendItem[]>([]);
	const [groupList, setGroupList] = useState<IGroupItem[]>([]);
    const [friendName, setFriendName] = useState('');
    const [groupName, setGroupName] = useState('');
    const [loading, setLoading] = useState(false);
    
    /**
     * 处理好友名称输入变化
     * @param e - 输入框变化事件
     */
    const handleFriendNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFriendName(e.target.value);
        if(e.target.value === '') {
            setFriendList([]);
        }
    };
    
    /**
     * 获取好友列表数据
     * @param username - 要搜索的用户名
     */
    const getFriendListData = async (username: string) => {
        try {
            if(username === ''){
                setFriendList([]);
                return;
            }
            const res = await getFriendList(username);
            if(res.code === HttpStatus.SUCCESS){
                setFriendList(res.data);
            }else{
                showMessage('error','获取好友列表失败')
            }
            } catch {
                showMessage('error','获取好友列表失败')
                setFriendList([]);
            }
    };

    /**
     * 添加好友
     * @param id - 好友用户ID
     * @param username - 好友用户名
     * @param avatar - 好友头像URL
     */
    const handleAddFriend = async (id:number,username:string,avatar:string) => {
        setLoading(true);
        try {
            const params = {
                id:id,
                username:username,
                avatar:avatar,
            };
            const res = await addFriend(params);
            if(res.code === HttpStatus.SUCCESS){
                showMessage('success','添加成功');
                setLoading(false);
                handleModal(false);
            }else {
                showMessage('error','添加失败');
                setLoading(false);
            }
            }catch {
                showMessage('error','添加失败');
                setLoading(false);
                }
            };
            
    /**
     * 处理群聊名称输入变化
     * @param e - 输入框变化事件
     */
    const handleGroupNameChange = (e:{ target: { value: React.SetStateAction<string> } }) => {
        setGroupName(e.target.value);
        if(e.target.value === ''){
            setGroupList([]);
        }
    };

    /**
     * 获取群聊列表数据
     * @param group_name - 要搜索的群聊名称
     */
    const getGroupChatListData = async (group_name: string) => {
        try {
            if(group_name === ''){
                setGroupList([]);
                return;
            }
            const res = await getGroupList(group_name);
            if(res.code === HttpStatus.SUCCESS && res.data ){
                setGroupList(res.data);
            }else{
                showMessage('error','获取群聊列表失败')
                setFriendList([]);
            }
        } catch {
            showMessage('error','获取群聊列表失败')
            setGroupList([]);
        }
    };
    
    /**
     * 加入群聊
     * @param group_id - 群聊ID
     */
    const joinGroup = async (group_id:number) => {
        setLoading(true);
        try {
            const params = {
                group_id:group_id,
            };
            const res = await addGroup(params);
            if(res.code === HttpStatus.SUCCESS){
                showMessage('success','加入群聊成功');
                setLoading(false);
                handleModal(false);
            }
            else{
                showMessage('error','加入群聊失败');
                setLoading(false);
            }
        } catch {
            showMessage('error','加入群聊失败');
            setLoading(false);
        }
    };
    
    // 配置标签页内容
    const items :TabsProps['items'] = [
        {
            key:'1',
            label:'添加好友',
            children: (
                <>
                    <div className={styles.searchBox}>
                        <Input 
                            size="small"
                            placeholder='搜索好友'
                            prefix={<SearchOutlined />}
                            onChange={value => {
                                handleFriendNameChange(value);
                            }}
                        />
                        <Button
                        type='primary'
                        onClick={() => {
                            getFriendListData(friendName);
                        }}
                        >
                            查找
                        </Button>
                    </div>
                    {friendList.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}/>
                    ):(
                       <div className={styles.searchResult}>
							{friendList.map(item => (
								<div className={styles.list_item} key={item.username}>
									<ImageLoad src={item.avatar} alt = ''/>
									<div className={styles.list_item_desc}>
										<span className={styles.list_item_username}>
											{item.username} ({item.username})
										</span>
										{
                                         // 显示添加好友按钮或已经是好友状态
                                         !item.status ? (
											<Button
												onClick={() => handleAddFriend(item.id, item.username, item.avatar)}
												type="primary"
												size="small"
												loading={loading}
											>
												加好友
											</Button>
										) : (
											<span> 已经是好友 </span>
										)}
									</div>
								</div>
							))}
						</div>
					)}
				</>
            )
        },
        {
            key:'2',
            label:'加入群聊',
            children: (
                <>
                    <div className={styles.searchBox}>
                        <Input
                            size="small"
                            placeholder="请输入群聊名称"
                            prefix={<SearchOutlined />}
                            onChange={value => {
                                handleGroupNameChange(value);
                            }}
                            />
                        <Button
                            type="primary"
                            onClick={() => {
                                getGroupChatListData(groupName);
                            }}
                            >
                            查找
                        </Button>
                    </div>
                    {groupList.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}/>
                        ):(
                            <div className={styles.searchResult}>
                            {groupList.map(item => (
                            <div className={styles.searchResult} key={item.group_id}>
                                <ImageLoad src={item.avatar} alt = ''/>
                                <div className={styles.list_item_desc}>
                                    <span className={styles.list_item_username}>
                                        {item.name}({item.number}人)
                                    </span>
                                    {
                                     // 显示加入群聊按钮或已经是群成员状态
                                     !item.status ? (
                                        <button onClick={() => joinGroup(item.group_id)}>加入群聊</button>
                                        ) : (
                                                <span> 已经是群成员 </span>
                                            )
                                        }
                                </div>
                            </div>
                        ))}
                        </div>
                    )}
                </>
            )
        }
    ];
    
    return (
        <>
            <Modal
                open={openmodal}
                footer={null}
                onCancel={() => {
                    handleModal(false);
                }}
            >
                <Tabs defaultActiveKey="1"  items={items} ></Tabs>
            </Modal>
        </>
    );
};

export default AddFriendOrGroupModal;