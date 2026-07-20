import { Router } from 'express';
import * as rtc from '../../service/rtc';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

export default () => {
	router.ws('/connect', rtc.connectRTC);
	router.get('/room_members', authenticateToken, rtc.getRoomMembers);
	return router;
};
