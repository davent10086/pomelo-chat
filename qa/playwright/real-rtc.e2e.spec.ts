import { test, expect, request, type Page } from '@playwright/test';

for (const mode of ['audio', 'video'] as const) {
  test(`真实 LiveKit ${mode}：邀请、接听、双向媒体与挂断`, async ({ page, browser }, testInfo) => {
    test.setTimeout(90000);
    const api = await request.newContext({ baseURL: 'http://127.0.0.1:3199/api/chat/v1/' });
    const peerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const peer = await peerContext.newPage();
    let completed = false;
    const logs: string[] = [];
    for (const [name, target] of [['caller', page], ['receiver', peer]] as const) {
      target.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') logs.push(`${name}: ${message.text().replace(/access_token=[^&\s']+/g, 'access_token=[redacted]')}`); });
      target.on('pageerror', error => logs.push(`${name}: ${error.message}`));
    }
    const instrument = async (target: Page) => {
      // Observe actual peer connections and getStats; do not replace SDP, ICE or media.
      await target.addInitScript(() => {
        const original = window.RTCPeerConnection;
        const connections: RTCPeerConnection[] = [];
        (window as unknown as { rtcConnections: RTCPeerConnection[] }).rtcConnections = connections;
        window.RTCPeerConnection = new Proxy(original, {
          construct(target, args) {
            const connection = Reflect.construct(target, args) as RTCPeerConnection;
            connections.push(connection);
            return connection;
          },
        });
      });
    };
    const received = async (target: Page, kind: string) => target.evaluate(async kind => {
      const connections = (window as unknown as { rtcConnections: RTCPeerConnection[] }).rtcConnections;
      let bytes = 0;
      for (const pc of connections) {
        const stats = await pc.getStats();
        stats.forEach(stat => {
          if (stat.type === 'inbound-rtp' && (stat.kind || stat.mediaType) === kind)
            bytes += stat.bytesReceived || 0;
        });
      }
      return bytes;
    }, kind);
    const stamp = Date.now();
    const create = async (index: number) => {
      const username = `rtc_${stamp}_${index}`, password = 'RtcReal123!';
      expect((await api.post('auth/register', { data: { username, password, phone: `13${String(stamp + index).slice(-9)}`, avatar: '' } })).ok()).toBeTruthy();
      const response = await api.post('auth/login', { data: { username, password } });
      expect(response.ok()).toBeTruthy();
      return { username, password, ...(await response.json()).data };
    };
    const login = async (target: Page, user: { username: string; password: string }) => {
      await target.goto('http://127.0.0.1:5199/login');
      await target.getByPlaceholder('请输入用户名').fill(user.username);
      await target.getByPlaceholder('请输入密码').fill(user.password);
      await target.locator('button[type=submit]').click();
      await expect(target).toHaveURL(/\/$/);
    };
    try {
      await instrument(page);
      await instrument(peer);
      const a = await create(1), b = await create(2);
      expect((await api.post('friend/add_friend', { headers: { Authorization: `Bearer ${a.token}` }, data: { id: b.info.id, username: b.username } })).ok()).toBeTruthy();
      const list = await api.get('message/chat_list', { headers: { Authorization: `Bearer ${a.token}` } });
      const room = (await list.json()).data[0].room;
      await login(page, a);
      await login(peer, b);
      await page.locator(`[id="chatList_${room}"]`).click();
      await peer.locator(`[id="chatList_${room}"]`).click();
      const invited = page.waitForResponse(response => response.url().endsWith('/rtc/invite'));
      await page.locator(mode === 'audio' ? 'button.icon-dianhua' : 'button.icon-video').click();
      expect((await invited).ok()).toBeTruthy();
      await expect(peer.getByAltText('接听')).toBeVisible();
      const accepted = peer.waitForResponse(response => response.url().endsWith('/rtc/accept'));
      await peer.getByAltText('接听').click();
      expect((await accepted).ok()).toBeTruthy();
      for (const target of [page, peer]) {
        await expect.poll(() => received(target, 'audio'), { timeout: 30000 }).toBeGreaterThan(0);
        if (mode === 'video') {
          await expect.poll(() => received(target, 'video'), { timeout: 30000 }).toBeGreaterThan(0);
          await expect.poll(() => target.locator('video').evaluateAll(elements => elements.filter(element => (element as HTMLVideoElement).videoWidth > 0).length)).toBeGreaterThan(0);
        }
      }
      const before = await received(peer, 'audio');
      await expect.poll(() => received(peer, 'audio')).toBeGreaterThan(before);
      await page.getByAltText('挂断').click();
      for (const target of [page, peer]) {
        await expect(target.getByRole('dialog')).toHaveCount(0);
        await expect.poll(() => target.evaluate(() => (window as unknown as { rtcConnections: RTCPeerConnection[] }).rtcConnections.every(pc => pc.connectionState === 'closed'))).toBeTruthy();
      }
      completed = true;
    } finally {
      if (!completed) {
        for (const [name, target] of [['caller', page], ['receiver', peer]] as const) {
          const diagnostics = await target.evaluate(async () => {
            const pcs = (window as unknown as { rtcConnections: RTCPeerConnection[] }).rtcConnections || [];
            const connections = [];
            for (const pc of pcs) {
              const stats: Record<string, unknown>[] = [];
              (await pc.getStats()).forEach(stat => { if (['inbound-rtp', 'outbound-rtp'].includes(stat.type)) stats.push(stat); });
              connections.push({ state: pc.connectionState, senders: pc.getSenders().map(sender => ({ kind: sender.track?.kind, readyState: sender.track?.readyState })), stats });
            }
            return { connections, videos: Array.from(document.querySelectorAll('video')).map(video => ({ width: video.videoWidth, height: video.videoHeight, paused: video.paused, readyState: video.readyState })) };
          });
          await testInfo.attach(`${name}-media`, { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
        }
        await testInfo.attach('browser-errors', { body: logs.join('\n'), contentType: 'text/plain' });
      }
      await peerContext.close();
      await api.dispose();
    }
  });
}
