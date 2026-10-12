import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { startChatBackend } from './chat-backend.mjs';
import { sampleChat } from './chat-sample.mjs';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const client = path.join(root, 'client');
const requireClient = createRequire(path.join(client, 'package.json'));
const viteEntry = path.join(path.dirname(requireClient.resolve('vite/package.json')), 'dist/node/index.js');
const { build, loadConfigFromFile } = await import(pathToFileURL(viteEntry).href);
const { chromium } = createRequire(path.join(root, 'package.json'))('@playwright/test');
const runs = Number(process.env.BENCH_RUNS || 7);
if (!Number.isInteger(runs) || runs < 2 || runs > 50) throw new Error('BENCH_RUNS must be 2..50');
const chat = process.env.BENCH_SCENARIO === 'chat';
const output = path.resolve(root, process.env.BENCH_OUTPUT || (chat ? 'test-results/chat-first-screen' : 'test-results/first-screen'));
let fixture;
const workspace = await mkdtemp(path.join(os.tmpdir(), 'pomelo-first-screen-'));
const conditions = { latencyMs: 150, downloadBytesPerSecond: 200000, uploadBytesPerSecond: 100000, cpuSlowdown: 4, viewport: { width: 1365, height: 768 } };

// Controlled ablation: same working tree and dependencies, only two optimizations disabled.
function eagerRoutes() {
  const imports = new Map();
  return {
    name: 'benchmark-eager-routes', enforce: 'pre',
    transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/router/config.ts')) return;
      const code = source.replace(/lazy\(\s*\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)\s*\)/g, (_all, specifier) => {
        if (!imports.has(specifier)) imports.set(specifier, `BenchmarkRoute${imports.size}`);
        return imports.get(specifier);
      });
      if (imports.size === 0) throw new Error('No lazy routes found; baseline would be invalid');
      return [...imports].map(([specifier, name]) => `import ${name} from ${JSON.stringify(specifier)};`).join('\n') + '\n' + code;
    }
  };
}

async function compile(variant) {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(client, 'vite.config.ts'), client);
  if (!loaded) throw new Error('Vite config not found');
  const config = loaded.config;
  const outDir = path.join(workspace, variant);
  const outputConfig = { ...config.build?.rollupOptions?.output };
  if (variant === 'baseline') delete outputConfig.manualChunks;
  await build({
    ...config, root: client, configFile: false, logLevel: 'warn',
    plugins: variant === 'baseline' ? [eagerRoutes(), ...(config.plugins || [])] : config.plugins,
    build: { ...config.build, outDir, emptyOutDir: true, rollupOptions: { ...config.build?.rollupOptions, output: outputConfig } }
  });
  return outDir;
}

async function serve(directory) {
  // Precompress once, so compression CPU cost does not distort the comparison.
  const files = new Map();
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else {
        const bytes = await readFile(full);
        files.set('/' + path.relative(directory, full).replaceAll('\\', '/'), { bytes, gzip: gzipSync(bytes), ext: path.extname(full) });
      }
    }
  }
  await visit(directory);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (chat && pathname.startsWith('/api/chat/v1/')) {
      const upstream = request(fixture.base + req.url, { method: req.method, headers: { ...req.headers, host: new URL(fixture.base).host } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream); return;
    }
    const file = files.get(pathname) || (pathname === '/login' || pathname === '/' ? files.get('/index.html') : undefined);
    if (!file) { res.writeHead(404); res.end(); return; }
    const compressed = /gzip/.test(req.headers['accept-encoding'] || '');
    const body = compressed ? file.gzip : file.bytes;
    res.writeHead(200, { 'Content-Type': types[file.ext] || 'application/octet-stream', 'Cache-Control': chat && file.ext !== '.html' ? 'public, max-age=31536000, immutable' : 'no-store', 'Content-Length': body.length, ...(compressed ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function sample(browser, origin, variant, round) {
  const context = await browser.newContext({ viewport: conditions.viewport, serviceWorkers: 'block' });
  try {
    // Never contact configured APIs or third parties. No account or database is needed.
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__benchmarkLcp = 0;
      new PerformanceObserver(list => { for (const item of list.getEntries()) window.__benchmarkLcp = item.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: conditions.latencyMs, downloadThroughput: conditions.downloadBytesPerSecond, uploadThroughput: conditions.uploadBytesPerSecond });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: conditions.cpuSlowdown });
    await page.goto(origin + '/login', { waitUntil: 'networkidle', timeout: 90000 });
    await page.getByRole('heading', { name: '欢迎登录' }).waitFor();
    await page.waitForFunction(() => window.__benchmarkLcp > 0 && performance.getEntriesByName('first-contentful-paint').length > 0);
    const result = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource').map(r => ({ url: new URL(r.name).pathname, encodedBytes: r.encodedBodySize, decodedBytes: r.decodedBodySize, transferBytes: r.transferSize, durationMs: r.duration }));
      const js = resources.filter(r => /\.js$/.test(r.url));
      return {
        fcpMs: performance.getEntriesByName('first-contentful-paint')[0].startTime,
        lcpMs: window.__benchmarkLcp,
        jsGzipBytes: js.reduce((sum, r) => sum + r.encodedBytes, 0),
        jsDecodedBytes: js.reduce((sum, r) => sum + r.decodedBytes, 0),
        jsRequests: js.length, resources
      };
    });
    if (errors.length || result.jsGzipBytes <= 0) throw new Error(`Invalid sample: ${JSON.stringify(errors)}`);
    await page.screenshot({ path: path.join(output, `${variant}-${round}.png`) });
    return { variant, round, ...result };
  } finally { await context.close(); }
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(samples) {
  const keys = ['jsGzipBytes', 'jsDecodedBytes', 'jsRequests', 'fcpMs', 'lcpMs', ...(chat ? ['jsNetworkGzipBytes', 'conversationListReadyMs', 'inputReadyAfterClickMs', 'socketOpenAfterClickMs', 'historyReceivedAfterClickMs', 'historyVisibleAfterClickMs'] : [])];
  return Object.fromEntries(keys.map(key => {
    const values = samples.map(s => s[key]);
    return [key, { median: median(values), min: Math.min(...values), max: Math.max(...values) }];
  }));
}

await mkdir(output, { recursive: true });
const servers = {};
let browser;
try {
  if (chat) {
    console.log('Starting isolated backend and seeding conversations...');
    fixture = await startChatBackend(root);
    process.env.VITE_API_BASE = '/api/chat/v1';
    process.env.VITE_WS_BASE = fixture.base.replace('http:', 'ws:') + '/api/chat/v1';
    process.env.VITE_SERVER_URL = fixture.base;
  }
  for (const variant of ['baseline', 'optimized']) {
    console.log(`Building ${variant}...`);
    servers[variant] = await serve(await compile(variant));
  }
  browser = await chromium.launch({ headless: true });
  // Warm each build once, but exclude warm-up samples. Every run uses a fresh browser context.
  const caches = chat ? ['cold', 'warm'] : ['cold'];
  const measure = (variant, round, cache) => chat ? sampleChat(browser, servers[variant].url, variant, round, cache, fixture, conditions, output) : sample(browser, servers[variant].url, variant, round);
  for (const variant of ['baseline', 'optimized']) await measure(variant, 'warmup', 'cold');
  const samples = [];
  for (let round = 1; round <= runs; round++) {
    // Alternate order to reduce drift caused by CPU temperature/background work.
    for (const variant of round % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']) {
      for (const cache of caches) {
        const result = await measure(variant, round, cache);
        samples.push(result);
        console.log(`${variant} ${cache} ${round}/${runs}: JS ${(result.jsGzipBytes / 1024).toFixed(1)} KiB, FCP ${result.fcpMs.toFixed(0)} ms, LCP ${result.lcpMs.toFixed(0)} ms`);
      }
    }
  }
  const baseline = summarize(samples.filter(s => s.variant === 'baseline' && (!chat || s.cache === 'cold')));
  const optimized = summarize(samples.filter(s => s.variant === 'optimized' && (!chat || s.cache === 'cold')));
  const reductionPercent = Object.fromEntries(Object.keys(baseline).map(key => [key, (baseline[key].median - optimized[key].median) / baseline[key].median * 100]));
  const metadata = {
    measuredAt: new Date().toISOString(), node: process.version, chromium: browser.version(), runs,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    route: chat ? '/' : '/login', compression: 'gzip', conditions, ...(chat ? { dataset: fixture.dataset, externalImages: 'Known external image hosts blocked via CDP; image-loading performance excluded.' } : {}),
    baseline: 'Current working tree with React.lazy routes made eager and manualChunks disabled; not a historical commit.',
    limitations: chat ? 'Authenticated homepage with real isolated local MySQL/Redis/backend and synthetic users. Existing token supplied before navigation; excludes login time. Assets throttled; loopback WebSockets may bypass Chromium HTTP throttling. Warm cache primes only homepage, not conversation. Both optimizations change together. Not production data; negative reduction means regression.' : 'Cold unauthenticated login page; local synthetic throttling; backend/API calls blocked. FCP/LCP are lab measurements, not production or authenticated-chat measurements. Both optimizations change together; individual effects are not isolated. Negative reduction means regression.'
  };
  const warm = chat ? { baseline: summarize(samples.filter(s => s.variant === 'baseline' && s.cache === 'warm')), optimized: summarize(samples.filter(s => s.variant === 'optimized' && s.cache === 'warm')) } : undefined;
  const checks = chat ? { performanceSamplesValid: true, latestMessageMissingSamples: samples.filter(s => !s.latestMessageRendered).map(s => ({ variant: s.variant, cache: s.cache, round: s.round })), note: 'Missing latest message is a functional finding, not a performance gain. See conversation screenshots.' } : undefined;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ metadata, baseline, optimized, reductionPercent, warm, checks, samples }, null, 2));
  const rows = Object.keys(baseline).map(key => `| ${key} | ${baseline[key].median.toFixed(2)} | ${optimized[key].median.toFixed(2)} | ${reductionPercent[key].toFixed(2)}% |`).join('\n');
  const warmRows = warm ? Object.keys(warm.baseline).map(key => `| ${key} | ${warm.baseline[key].median.toFixed(2)} | ${warm.optimized[key].median.toFixed(2)} |`).join('\n') : '';
  const markdown = `# 首屏优化受控测试\n\n${metadata.baseline}\n\n路由：${metadata.route}；冷缓存；gzip；每组 ${runs} 次；CPU ×4；延迟 150 ms；下载 200000 B/s。汇总使用中位数。\n\n| 指标 | 对照组 | 当前配置 | 降低比例 |\n| --- | ---: | ---: | ---: |\n${rows}\n\n${warm ? '## 热缓存\n\n| 指标 | 对照组 | 当前配置 |\n| --- | ---: | ---: |\n' + warmRows : ''}\n\n${metadata.limitations}\n\n原始数据与资源清单：report.json。构建目录：${workspace}\n`;
  await writeFile(path.join(output, 'report.md'), markdown);
  if (chat) await writeFile(path.join(output, 'report.md'), markdown + `\n## 功能检查\n\n列表、输入框、连接与首批历史消息检查完成；${checks.latestMessageMissingSamples.length}/${samples.length} 个样本在首批历史消息出现时未渲染最新消息。请复查打开会话后的滚动位置，不能将此项视为全部通过。\n`);
  console.log(markdown);
  console.log(`Saved: ${output}`);
} finally {
  await browser?.close();
  for (const server of Object.values(servers)) await server.close();
  await fixture?.close();
}
