import { Router } from 'express';
import * as group from '../../service/group';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

export default () => {
	router.get('/group_list', authenticateToken, group.getGroupChatList);
	router.get('/search_group', authenticateToken, group.searchGroupChat);
	router.get('/group_info', authenticateToken, group.getGroupChatInfo);
	router.post('/create_group', authenticateToken, group.createGroupChat);
	router.post('/invite_friend', authenticateToken, group.inviteFriendToGroupChat);
	router.post('/add_group', authenticateToken, group.joinGroupChat);
	router.get('/group_member', authenticateToken, group.getGroupMemberList);
	return router;
};
