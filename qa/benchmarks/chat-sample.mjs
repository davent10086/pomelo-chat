import path from 'node:path';

export async function sampleChat(browser, origin, variant, round, cache, fixture, conditions, output) {
  const context = await browser.newContext({ viewport: conditions.viewport, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ token, info, rooms }) => {
      sessionStorage.setItem('pomelo-chat.authToken', JSON.stringify(token));
      sessionStorage.setItem('pomelo-chat.userInfo', JSON.stringify(info));
      window.__bench = { lcp: 0, list: 0, socket: 0, history: 0, input: 0, message: 0, click: 0 };
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__bench.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          if (String(args[0]).includes('connect_chat')) {
            this.addEventListener('open', () => { window.__bench.socket = performance.now(); });
            this.addEventListener('message', e => { try { if (JSON.parse(e.data).name === 'history') window.__bench.history = performance.now(); } catch {} });
          }
        }
      };
      const visible = el => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const observe = () => {
        const b = window.__bench;
        if (!b.list && rooms.every(room => visible(document.getElementById('chatList_' + room)))) b.list = performance.now();
        if (b.click && !b.input && visible(document.querySelector('[aria-label="消息输入框"]'))) b.input = performance.now();
        if (b.click && !b.message && [...document.querySelectorAll('[data-message-index]')].some(el => visible(el) && /benchmark-message-\d{3}/.test(el.textContent))) b.message = performance.now();
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    }, { token: fixture.auth.token, info: fixture.auth.info, rooms: fixture.rooms.map(r => r.room) });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // CDP URL blocking preserves HTTP caching, unlike Playwright routing.
    await cdp.send('Network.setBlockedURLs', { urls: ['*://img.qovv.cn/*', '*://images.pexels.com/*', '*://p0.meituan.net/*', '*://p1.meituan.net/*', '*://ui-avatars.com/*'] });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: cache === 'cold' });
    // Routing interception disables Chromium HTTP cache, so deliberately do not use context.route here.
    if (cache === 'warm') {
      await page.goto(origin + '/', { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.__bench.list > 0);
    }
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: conditions.latencyMs, downloadThroughput: conditions.downloadBytesPerSecond, uploadThroughput: conditions.uploadBytesPerSecond });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: conditions.cpuSlowdown });
    await page.goto(origin + '/', { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForFunction(() => window.__bench.list > 0 && window.__bench.lcp > 0);
    const initial = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource').map(r => ({ url: new URL(r.name).pathname, encodedBytes: r.encodedBodySize, decodedBytes: r.decodedBodySize, transferBytes: r.transferSize, durationMs: r.duration }));
      const js = resources.filter(r => /\.js$/.test(r.url));
      return { fcpMs: performance.getEntriesByName('first-contentful-paint')[0].startTime, lcpMs: window.__bench.lcp, conversationListReadyMs: window.__bench.list,
        jsGzipBytes: js.reduce((s, r) => s + r.encodedBytes, 0), jsNetworkGzipBytes: js.reduce((s, r) => s + (r.transferBytes > 0 ? r.encodedBytes : 0), 0),
        jsDecodedBytes: js.reduce((s, r) => s + r.decodedBytes, 0), jsRequests: js.length, resources };
    });
    if (cache === 'warm' && initial.jsNetworkGzipBytes !== 0) throw new Error('Warm-cache JS still transferred over network; sample invalid');
    if (cache === 'cold' && initial.jsNetworkGzipBytes <= 0) throw new Error('Cold-cache sample did not download JS');
    await page.screenshot({ path: path.join(output, `${variant}-${cache}-${round}-home.png`) });
    await page.evaluate(room => { window.__bench.click = performance.now(); document.getElementById('chatList_' + room).click(); }, fixture.selectedRoom);
    await page.waitForFunction(() => window.__bench.input > 0 && window.__bench.message > 0 && window.__bench.history > 0 && window.__bench.socket > 0, undefined, { timeout: 30000 });
    const interaction = await page.evaluate(() => {
      const b = window.__bench;
      return { inputReadyAfterClickMs: b.input - b.click, socketOpenAfterClickMs: b.socket - b.click, historyReceivedAfterClickMs: b.history - b.click, historyVisibleAfterClickMs: b.message - b.click };
    });
    const latestMessageRendered = await page.locator('[data-message-index]').filter({ hasText: fixture.dataset.lastMessage }).count() > 0;
    await page.screenshot({ path: path.join(output, `${variant}-${cache}-${round}-conversation.png`) });
    if (errors.length || initial.jsGzipBytes <= 0 || Object.values(interaction).some(v => v < 0)) throw new Error(`Invalid chat sample: ${JSON.stringify(errors)}`);
    return { variant, round, cache, latestMessageRendered, ...initial, ...interaction };
  } catch (error) {
    for (const page of context.pages()) {
      await page.screenshot({ path: path.join(output, `${variant}-${cache}-${round}-failure.png`) }).catch(() => {});
      console.error('Chat readiness diagnostics:', await page.evaluate(() => ({ timings: window.__bench, messageRows: document.querySelectorAll('[data-message-index]').length, input: !!document.querySelector('[aria-label="消息输入框"]'), text: document.body.innerText.slice(-1500) })).catch(() => ({})));
    }
    throw error;
  } finally { await context.close(); }
}
