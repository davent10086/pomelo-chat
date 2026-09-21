import { Router } from 'express';
import * as rtc from '../../service/rtc';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

export default () => {
	router.post('/join-token', authenticateToken, rtc.createJoinToken);
	router.post('/invite', authenticateToken, rtc.invite);
	router.post('/end', authenticateToken, rtc.endCall);
	return router;
};
