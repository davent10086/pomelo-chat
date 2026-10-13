import { Router } from 'express';
import { rtcHttp as rtc } from '../../composition';
import { authenticateToken } from '../../modules/identity/middleware';

const router = Router();

export default () => {
	router.post('/join-token', authenticateToken, rtc.createJoinToken);
	router.post('/invite', authenticateToken, rtc.invite);
	router.post('/accept', authenticateToken, rtc.acceptCall);
	router.post('/end', authenticateToken, rtc.endCall);
	return router;
};
