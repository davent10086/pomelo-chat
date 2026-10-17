import { createIdentityApplication } from './modules/identity/public';
import {
	createFriendApplication,
	createGroupApplication,
	initializeDefaultFriendGroup,
	updateContactPresence
} from './modules/social/public';
import { initializeGroupMessage } from './modules/messaging/public';
import * as messaging from './modules/messaging/application';
import * as messageSearch from './modules/messaging/search-application';
import * as files from './modules/files/application';
import { createRtcCalls, createRtcApplication } from './modules/rtc/public';
import {
	NotificationUser,
	getNotificationSocket,
	notifySessionChanged
} from './modules/realtime/public';
import { publishReadReceipt } from './modules/realtime/public';
import * as actions from './modules/assistant/actions';
import * as agent from './modules/assistant/agent-application';
import { createHttpHandlers as identityHandlers } from './modules/identity/http';
import { createHttpHandlers as socialHandlers } from './modules/social/http';
import { createHttpHandlers as messagingHandlers } from './modules/messaging/http';
import { createHttpHandlers as fileHandlers } from './modules/files/http';
import { createHttpHandlers as rtcHandlers } from './modules/rtc/http';
import { createHttpHandlers as assistantHandlers } from './modules/assistant/http';
import { createUploadAccessMiddleware } from './modules/files/access-http';
import { verifyTokenWithSession, isAuthenticatedPayload } from './modules/identity/public';
export const rtcCalls = createRtcCalls({ notifyUser: NotificationUser });
export const identity = createIdentityApplication({
	releaseUserCall: rtcCalls.releaseUserCall,
	notifySessionChanged,
	initializeDefaultFriendGroup,
	updateContactPresence
});
const socialEffects = {
	notifyUser: NotificationUser,
	isOnline: (username: string) => !!getNotificationSocket(username),
	initializeGroupMessage
};
export const social = {
	friends: createFriendApplication(socialEffects),
	groups: createGroupApplication(socialEffects)
};
export const rtc = createRtcApplication({ calls: rtcCalls, notifyUser: NotificationUser });
export const identityHttp = identityHandlers(identity);
export const socialHttp = socialHandlers(social);
export const messagingHttp = messagingHandlers({ ...messaging, ...messageSearch }, publishReadReceipt);
export const filesHttp = fileHandlers(files);
export const rtcHttp = rtcHandlers(rtc);
export const assistantHttp = assistantHandlers({ ...actions, ...agent });
export const authenticateUploadAccess = createUploadAccessMiddleware(
	verifyTokenWithSession,
	isAuthenticatedPayload
);
