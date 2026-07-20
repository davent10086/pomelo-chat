import { Router } from 'express';
import * as message from '../../service/message';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

export default () => {
	router.get('/chat_list', authenticateToken, message.getChatList);
	router.ws('/connect_chat', message.connectChat);
	return router;
};
