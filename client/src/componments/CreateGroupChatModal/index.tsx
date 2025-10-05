import { Button,Modal,Input,Form, Tree } from "antd";
import { useEffect,useMemo, useRef, useState } from "react";
import { getFriendList,createGroup,inviteFriend } from "./api";
import styles from "./index.module.less";
import {
    ICreateGroupModal,
	ICreateGroupForm,
	IFriendItem,
	IFriendGroupItem,
	IGroupMemberItem,
	ICreateGroupParams
} from "./type";

import ImageLoad from "../ImageLoad";
import { ImageUpLoad } from "../ImageUpload";
import useShowMessage from "@/hooks/useShowMessage";
import { HttpStatus } from "@/utils/constant";
import React from "react";

/**
 * 创建群聊/邀请好友组件
 * @param props - 组件属性
 * @param props.openmodal - 控制模态框是否显示
 * @param props.handleModal - 控制模态框显示/隐藏的回调函数
 * @param props.type - 模态框类型 ('invite' 邀请进群 | 'create' 创建群聊)
 * @param props.groupChatInfo - 群聊信息（邀请时使用）
 */
const CreateGroupModal = (props:ICreateGroupModal) =>{
    const showMessage = useShowMessage();
    const {openmodal,handleModal,type,groupChatInfo} = props;
    const [friendList,setFriendList] = useState<IFriendGroupItem[]>([]);
    const [checkedFriends,setCheckedFriends] = useState<[]>([]);
    const [loading,setLoading] = useState(false);
    const [createGroupFormInstance] = Form.useForm<ICreateGroupForm>();
    const step0Ref = useRef<HTMLDivElement|null>(null);
    const step1Ref = useRef<HTMLDivElement|null>(null);

    /**
     * 将好友列表转换为树形结构数据
     */
const treeData = friendList.map(group => {
		return {
			title: <span>{group.name}</span>,
			key: group.name,
			selectable: false,
			disabled: group.friend.length ? false : true,
			children: group.friend.map(friend => ({
				title: (
					<div className={styles.nodeContent}>
						<ImageLoad src={friend.avatar}  alt=""/>
						<span>{friend.remark}</span>
					</div>
				),
				key: JSON.stringify(friend),
				isLeaf: true,
				selectable: false
			}))
		};
	});

    /**
     * 获取好友列表数据
     */
    const refreshFriendList = async () => {
        try{
            const res = await getFriendList();
            if(res.code === HttpStatus.SUCCESS && res.data){
                setFriendList(res.data);
            }else{
                showMessage('error','获取好友列表失败');
            }
        }catch{
                showMessage('error','获取好友列表失败');
            }
        };
        
        /**
         * 处理取消操作
         */
        const handleCancel = () => {
            handleModal(false);
        };

        /**
         * 切换步骤视图
         * @param step - 步骤编号 (0 或 1)
         */
        const handleSwitch = (step:number) =>{
            if(step === 0 && step0Ref.current && step1Ref.current){
                step1Ref.current.style.opacity = '0';
                step0Ref.current.style.opacity = '1';
                setTimeout(() =>{
                    if(step1Ref.current && step0Ref.current){
                        step1Ref.current.style.display = 'none';
                        step0Ref.current.style.display = 'block';
                    }
                    },500);
        }else if (step ==1 &&step0Ref.current && step1Ref.current){
            if (checkedFriends.length !== 0){
                step0Ref.current.style.opacity = '0';
                step1Ref.current.style.opacity = '1';
                setTimeout(() =>{
                    if(step1Ref.current && step0Ref.current){
                        step0Ref.current.style.display = 'block';
                        step1Ref.current.style.display = 'none';
                    }
                },500);
            }else{
                showMessage('error','请选择好友');
            }
        }
    };
    /**
     * 处理创建群聊
     * @param values - 表单数据
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleCreateGroup = async (values:any) => {
        setLoading(true);
        const selectedFriends : IGroupMemberItem[] = [];
        checkedFriends.map(item => {
            try{
                const parsedItem = JSON.parse(item);
                if (parsedItem.username)
                    if (parsedItem.username){
                        selectedFriends.push({
                            user_id:parsedItem.user_id,
                            username:parsedItem.username,
                            avatar:parsedItem.avatar,
                        });
                    }
                } catch {
                    showMessage('error','获取好友列表失败');
                }
        });
        if (selectedFriends.length === 0){
            showMessage('error','请选择好友');
            setLoading(false);
            return;
        }
        try{
            const createGroupParams:ICreateGroupParams = {
                name:values.groupName,
                announcement:values.announcement ? values.announcement : null,
                members:selectedFriends,
                avatar:values.avatar,
        };
        const res = await createGroup(createGroupParams);
        if(res.code === HttpStatus.SUCCESS){
            showMessage('success','创建群聊成功');
            setLoading(false);
            handleModal(false);
        }else{
            showMessage('error','创建群聊失败');
            setLoading(false);
        }
        }catch{
            showMessage('error','创建群聊失败');
            setLoading(false);
    }
};

    /**
     * 处理邀请好友进群
     */
    const handlInvite = async() => {
        setLoading(true);
        const selectedFriends : IGroupMemberItem[] = [];
        checkedFriends.map(item => {
            try{
                const parsedItem = JSON.parse(item);
                if (parsedItem.username){
                    selectedFriends.push({
                        user_id:parsedItem.user_id,
                        username:parsedItem.username,
                        avatar:parsedItem.avatar,
                    });
                }
            }catch{
                showMessage('error','获取好友列表失败');
            }
    });
    if (selectedFriends.length !== 0 ){
        try{
            const inviteFriendParams = {
                groupId:groupChatInfo!.id,
                invitationList:selectedFriends,
            };
            const res = await inviteFriend(inviteFriendParams);
            if(res.code === HttpStatus.SUCCESS){
                showMessage('success','邀请成功');
                setLoading(false);
                handleModal(false);
            }else if (res.code === HttpStatus.USER_EXIST){
                showMessage('error','邀请失败，全部成员已存在群聊中');
                setLoading(false);
            }else{
                showMessage('error',res.message);
                setLoading(false);
            }
        }catch{
            showMessage('error','邀请失败');
            setLoading(false);
        }
        }else{
            showMessage('error','邀请失败');
            setLoading(false);
        }
    };
    useEffect(() => {
        refreshFriendList();
    },[]);

    /**
     * 好友列表树组件
     */
    const FriendTree = useMemo(() => {
        return (
            <div className={styles.list}>
                <Tree
                    checkable
                    defaultExpandAll={true}
                    treeData={treeData}
                    onCheck = {checkedKeys => {
                        setCheckedFriends(checkedKeys as []);
                    }}
                    />
            </div>
        );
    },[friendList]);

       return (
		<>
			<Modal
				title={type === 'invite' ? '邀请新的好友进群聊' : '创建群聊'}
				open={openmodal}
				footer={null}
				onCancel={handleCancel}
				width="5rem"
			>
				<div className={styles.createModal}>
					<div className={`${styles.step} ${styles.step0}`} ref={step0Ref}>
						<div className={styles.selectContainer}>
							<div className={styles.friendList}>
								<div className={styles.title}> 好友列表 </div>
								{FriendTree}
							</div>
							<div className={styles.selectList}>
								<div className={styles.title}> 已选择 </div>
								<div className={styles.list}>
									{checkedFriends.map(item => {
										let selectedFriend = {} as IFriendItem;
										try {
											const parsedItem = JSON.parse(item);
											if (parsedItem.username) {
												selectedFriend = parsedItem;
												return (
													<div key={selectedFriend.username} className={styles.friendInfo}>
														<div className={styles.avatar}>
															<ImageLoad src={selectedFriend.avatar} alt='avatar' />
														</div>
														<span className={styles.username}>{selectedFriend.username}</span>
													</div>
												);
											}
										} catch {
											/* empty */
										}
									})}
								</div>
							</div>
						</div>
						<div className={styles.btns}>
							{type === 'invite' ? (
								<Button onClick={handlInvite} loading={loading}>
									邀请
								</Button>
							) : (
								<Button onClick={() => handleSwitch(1)}> 下一步 </Button>
							)}
						</div>
					</div>
					<div className={`${styles.step} ${styles.step1}`} ref={step1Ref}>
						<div className={styles.selectContainer}>
							<Form
								form={createGroupFormInstance}
								name="createGroupChatForm"
								onFinish={handleCreateGroup}
							>
								<Form.Item
									label="头像"
									rules={[{ required: true, message: '请上传头像' }]}
									name="groupAvatar"
								>
									<ImageUpLoad
										onUploadSuccess={filePath => {
											createGroupFormInstance.setFieldsValue({ groupAvatar: filePath });
										}}
									/>
								</Form.Item>
								<Form.Item
									label="群名"
									rules={[{ required: true, message: '请输入群名' }]}
									name="groupName"
								>
									<Input maxLength={10} showCount={true} placeholder="请输入群名" />
								</Form.Item>
								<Form.Item label="公告" name="announcement">
									<Input maxLength={30} showCount={true} />
								</Form.Item>
								<Form.Item>
									<div className={styles.btns}>
										<Button onClick={() => handleSwitch(0)}> 上一步 </Button>
										<Button type="primary" loading={loading} htmlType="submit">
											确定
										</Button>
									</div>
								</Form.Item>
							</Form>
						</div>
					</div>
				</div>
			</Modal>
		</>
	    );
    };

export default CreateGroupModal;