import { Router } from 'express';
import * as message from '../../service/message';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

export default () => {
	router.get('/chat_list', authenticateToken, message.getChatList);
	router.get('/search', authenticateToken, message.searchMessages);
	router.get('/context', authenticateToken, message.getMessageContext);
	router.post('/resolve', authenticateToken, message.resolveMessages);
	router.get('/history', authenticateToken, message.getHistory);
	router.post('/read', authenticateToken, message.markRead);
	router.ws('/connect_chat', message.connectChat);
	return router;
};
