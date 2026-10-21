const api = process.env.TEST_API_ORIGIN;
const web = process.env.TEST_WEB_ORIGIN;
if (!api || !web) throw new Error('Use pnpm test:e2e / pnpm test:rtc to allocate isolated services and ports');
export const testApiOrigin = api;
export const testApiURL = `${api}/api/chat/v1/`;
export const testWebOrigin = web;
export const testLiveKitHttp = process.env.LIVEKIT_HTTP_URL || 'http://127.0.0.1:7880';
export const testLiveKitKey = process.env.LIVEKIT_API_KEY || 'devkey';
export const testLiveKitSecret = process.env.LIVEKIT_API_SECRET || 'secret';
