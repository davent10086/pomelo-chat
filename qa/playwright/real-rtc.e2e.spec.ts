import { createUserFactory, connectFriends, login, setup } from './helpers/chat';
import { test, expect, request, type Page } from '@playwright/test';

for (const mode of ['audio', 'video'] as const) {
  test(`真实 LiveKit ${mode}：邀请、接听、双向媒体与挂断`, async ({ page, browser }, testInfo) => {
    test.setTimeout(90000);
    const api = await request.newContext({ baseURL: 'http://127.0.0.1:3199/api/chat/v1/' });
    const peerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const peer = await peerContext.newPage();
    let completed = false;
    const logs: string[] = [];
    const endCounts = { caller: 0, receiver: 0 };
    for (const [name, target] of [['caller', page], ['receiver', peer]] as const) {
      target.on('request', request => { if (request.url().endsWith('/rtc/end')) endCounts[name]++; });
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
    const create = createUserFactory(api, 'rtc');
    try {
      await instrument(page);
      await instrument(peer);
      const a = await create(1), b = await create(2);
      const room = await connectFriends(api, a, b);
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
      await expect.poll(() => endCounts).toEqual({ caller: 1, receiver: 1 });
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

for (const mode of ['audio', 'video'] as const) {
  test(`${mode} 取消后迟到的邀请会关闭且不会再加入媒体`, async ({ page, browser }) => {
    const { api, a, b, room } = await setup();
    const peerContext = await browser.newContext();
    const peer = await peerContext.newPage();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let invited = false, ended = 0, joined = 0;
    page.on('request', request => {
      if (request.url().endsWith('/rtc/end')) ended++;
      if (request.url().endsWith('/rtc/join-token')) joined++;
    });
    await page.route('**/rtc/invite', async route => {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      invited = true;
      await wait;
      await route.fulfill({ response }).catch(() => undefined);
    });
    try {
      await login(peer, b, room);
      await login(page, a, room);
      await page.locator(mode === 'audio' ? 'button.icon-dianhua' : 'button.icon-video').click();
      await expect.poll(() => invited).toBe(true);
      await page.getByAltText('挂断').click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      release();
      await expect.poll(() => ended).toBe(1);
      expect(joined).toBe(0);
    } finally { release(); await peerContext.close(); await api.dispose(); }
  });
}
