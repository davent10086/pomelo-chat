// @tags security regression rtc
import { testApiURL, testLiveKitHttp, testLiveKitKey, testLiveKitSecret } from "../../e2e/helpers/endpoints";
import { createUserFactory, connectFriends, login, setup } from '../../e2e/helpers/chat';
import { test, expect, request, type Page } from '@playwright/test';

test('server end disconnects real media without client hangup and cached tokens cannot recreate the room', async ({ page, browser }) => {
  test.setTimeout(90000);
  const { api, a, b, room } = await setup();
  const peerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const peer = await peerContext.newPage();
  let credentials: { token: string; roomName: string; serverUrl: string } | undefined;
  // Ignore business notifications so only an SFU kick can terminate the peer's media.
  for (const target of [page, peer]) await target.addInitScript(() => {
    window.addEventListener('pomelo-call-state', event => event.stopImmediatePropagation());
  });
  page.on('response', async response => {
    if (response.url().endsWith('/rtc/join-token') && response.ok()) credentials = (await response.json()).data;
  });
  try {
    await login(page, a, room); await login(peer, b, room);
    const invitation = page.waitForResponse(response => response.url().endsWith('/rtc/invite'));
    await page.getByRole('button', { name: '语音聊天', exact: true }).click();
    const callId = (await (await invitation).json()).data.callId;
    await peer.getByAltText('接听').click();
    await expect.poll(() => credentials).toBeTruthy();
    await expect(page.getByAltText('挂断')).toBeVisible();
    await expect(peer.getByAltText('挂断')).toBeVisible();
    const { RoomServiceClient } = require('../../../server/node_modules/livekit-server-sdk');
    const service = new RoomServiceClient(testLiveKitHttp, testLiveKitKey, testLiveKitSecret);
    await expect.poll(async () => (await service.listParticipants(credentials!.roomName)).length).toBe(2);
    const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    expect((await api.post('rtc/end', { headers: { Authorization: `Bearer ${token}` }, data: { callId } })).ok()).toBeTruthy();
    await expect.poll(async () => (await service.listRooms([credentials!.roomName])).length).toBe(0);
    for (const target of [page, peer]) await expect(target.getByRole('dialog')).toHaveCount(0);
    expect((await api.post('rtc/join-token', {
      headers: { Authorization: `Bearer ${token}` }, data: { callId, room, type: 'private' },
    })).status()).toBe(403);
    const rejoined = await page.evaluate(async credentials => {
      const { Room } = await import('/node_modules/.vite/deps/livekit-client.js');
      const attempt = new Room();
      try { await attempt.connect(credentials.serverUrl, credentials.token); return true; }
      catch { return false; }
      finally { await attempt.disconnect(); }
    }, credentials!);
    expect(rejoined).toBe(false);
  } finally { await peerContext.close(); await api.dispose(); }
});

test('leaving a group call retires cached tokens while remaining participants reconnect', async ({ page, browser }) => {
  test.setTimeout(90000);
  const { api, a, b } = await setup();
  const headers = { Authorization: `Bearer ${a.token}` };
  const name = 'rtc-group-' + Date.now();
  expect((await api.post('group/create_group', { headers, data: {
    name, avatar: '', members: [{ user_id: b.info.id, username: b.username }],
  } })).ok()).toBeTruthy();
  const groups = (await (await api.get('group/group_list', { headers })).json()).data;
  const room = groups.find((group: { name: string }) => group.name === name).room;
  const peerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const peer = await peerContext.newPage();
  let mediaRoom = '';
  let peerMediaRoom = '';
  let cachedCredentials: { token: string; serverUrl: string } | undefined;
  page.on('response', async response => {
    if (response.url().endsWith('/rtc/join-token') && response.ok()) {
      const data = (await response.json()).data;
      mediaRoom = data.roomName; cachedCredentials = data;
    }
  });
  peer.on('response', async response => {
    if (response.url().endsWith('/rtc/join-token') && response.ok()) peerMediaRoom = (await response.json()).data.roomName;
  });
  await page.addInitScript(() => window.addEventListener('pomelo-call-state', event => event.stopImmediatePropagation()));
  try {
    await login(page, a, room); await login(peer, b, room);
    const invitation = page.waitForResponse(response => response.url().endsWith('/rtc/invite'));
    await page.getByRole('button', { name: '语音聊天', exact: true }).click();
    const callId = (await (await invitation).json()).data.callId;
    await peer.getByAltText('接听').click();
    const { RoomServiceClient } = require('../../../server/node_modules/livekit-server-sdk');
    const service = new RoomServiceClient(testLiveKitHttp, testLiveKitKey, testLiveKitSecret);
    await expect.poll(async () => mediaRoom ? (await service.listParticipants(mediaRoom)).length : 0).toBe(2);
    const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pomelo-chat.authToken') || '""'));
    const ended = await api.post('rtc/end', { headers: { Authorization: `Bearer ${token}` }, data: { callId } });
    expect(ended.ok()).toBeTruthy(); expect((await ended.json()).data.status).toBe('active');
    await expect.poll(async () => (await service.listRooms([mediaRoom])).length).toBe(0);
    await expect.poll(() => peerMediaRoom).toContain('-g1');
    await expect.poll(async () => (await service.listParticipants(peerMediaRoom)).map((participant: { identity: string }) => participant.identity)).toEqual([b.username]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(peer.getByAltText('挂断')).toBeVisible();
    expect((await api.post('rtc/join-token', {
      headers: { Authorization: `Bearer ${token}` }, data: { callId, room, type: 'group' },
    })).status()).toBe(403);
    const rejoined = await page.evaluate(async credentials => {
      const { Room } = await import('/node_modules/.vite/deps/livekit-client.js');
      const attempt = new Room();
      try { await attempt.connect(credentials.serverUrl, credentials.token); return true; }
      catch { return false; }
      finally { await attempt.disconnect(); }
    }, cachedCredentials!);
    expect(rejoined).toBe(false);
    // A deliberate rejoin obtains credentials for the current room generation.
    await page.getByRole('button', { name: '语音聊天', exact: true }).click();
    await expect.poll(async () => (await service.listParticipants(peerMediaRoom)).length).toBe(2);
    await page.getByAltText('挂断').click();
    await expect.poll(() => peerMediaRoom).toContain('-g2');
    await expect.poll(async () => (await service.listParticipants(peerMediaRoom)).map((participant: { identity: string }) => participant.identity)).toEqual([b.username]);
    await peer.getByAltText('挂断').click();
    await expect.poll(async () => (await service.listRooms([peerMediaRoom])).length).toBe(0);
  } finally { await peerContext.close(); await api.dispose(); }
});

for (const mode of ['audio', 'video'] as const) {
  test(`真实 LiveKit ${mode}：邀请、接听、双向媒体与挂断`, async ({ page, browser }, testInfo) => {
    test.setTimeout(90000);
    const api = await request.newContext({ baseURL: testApiURL });
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
      await page.getByRole('button', { name: mode === 'audio' ? '语音聊天' : '视频聊天', exact: true }).click();
      expect((await invited).ok()).toBeTruthy();
      await expect(peer.getByAltText('接听')).toBeVisible();
      await peer.reload();
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
      const mediaEvidence = [];
      for (const [name, target] of [['caller', page], ['receiver', peer]] as const) {
        for (const kind of mode === 'video' ? ['audio', 'video'] : ['audio']) {
          const initialBytes = await received(target, kind);
          await expect.poll(() => received(target, kind), { timeout: 15000 }).toBeGreaterThan(initialBytes);
          mediaEvidence.push({ side: name, kind, initialBytes, finalBytes: await received(target, kind) });
        }
      }
      await testInfo.attach('verified-media-flow', { body: JSON.stringify(mediaEvidence, null, 2), contentType: 'application/json' });
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
      await page.getByRole('button', { name: mode === 'audio' ? '语音聊天' : '视频聊天', exact: true }).click();
      await expect.poll(() => invited).toBe(true);
      await page.getByAltText('挂断').click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      release();
      await expect.poll(() => ended).toBe(1);
      expect(joined).toBe(0);
    } finally { release(); await peerContext.close(); await api.dispose(); }
  });
}
