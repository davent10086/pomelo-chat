import { identityHttp } from '../../composition';
export const { login, logout, register, forgetPassword, updateInfo } = identityHttp;
export { initUserNotification } from '../../modules/realtime/notification-socket';
