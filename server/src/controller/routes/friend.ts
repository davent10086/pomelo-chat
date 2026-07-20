import { Router } from 'express';
import * as friend from '../../service/friend';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

export default () => {
	router.get('/friend_list', authenticateToken, friend.getFriendList);
	router.get('/group_list', authenticateToken, friend.getFriendGroupList);
	router.get('/friend_id', authenticateToken, friend.getFriendById);
	router.get('/search_user', authenticateToken, friend.searchUser);
	router.post('/create_group', authenticateToken, friend.createFriendGroup);
	router.post('/add_friend', authenticateToken, friend.addFriend);
	router.post('/update_friend', authenticateToken, friend.updateFriend);
	return router;
};
