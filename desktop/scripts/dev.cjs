const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const root = path.resolve(__dirname, '../..');
const port = Number(process.env.POMELO_DESKTOP_PORT || 5173);
const server = process.env.POMELO_SERVER_URL || 'http://127.0.0.1:3000';
const url = `http://127.0.0.1:${port}`;
const children = new Set();
let stopping = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function start(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  children.add(child);
  child.on('error', error => { console.error(error.message); shutdown(1); });
  child.on('exit', code => { children.delete(child); if (!stopping) shutdown(code || 0); });
  return child;
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const exits = [...children].map(child => new Promise(resolve => {
    child.once('exit', resolve);
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { child.kill(); });
    } else child.kill('SIGTERM');
  }));
  Promise.all(exits).then(() => process.exit(code));
  setTimeout(() => process.exit(code), 5000).unref();
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

async function run() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid desktop port');
  const parsedServer = new URL(server);
  if (!['http:', 'https:'].includes(parsedServer.protocol)) throw new Error('Invalid backend URL');
  // Never connect the desktop bridge to an unrelated existing development server.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is occupied; set POMELO_DESKTOP_PORT to a free port.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  const vite = require.resolve('../../client/node_modules/vite/bin/vite.js');
  start(process.execPath, [vite, 'client', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    ...process.env, POMELO_DESKTOP_DEV: '1',
    VITE_API_BASE: `${parsedServer.origin}/api/chat/v1`,
    VITE_WS_BASE: `${parsedServer.origin.replace(/^http/, 'ws')}/api/chat/v1`,
    VITE_SERVER_URL: parsedServer.origin
  });
  for (let attempt = 0; attempt < 150 && !stopping; attempt++) {
    try {
      const response = await fetch(`${url}/desktop-assistant`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.text()).includes('/src/main.tsx')) {
        const env = { ...process.env, POMELO_DESKTOP_URL: url, POMELO_SERVER_URL: parsedServer.origin };
        delete env.ELECTRON_RUN_AS_NODE;
        start(require('electron'), [path.resolve(__dirname, '..')], env);
        console.log(`Desktop: ${url} | backend: ${parsedServer.origin}`);
        return;
      }
    } catch { /* Vite is starting. */ }
    await delay(200);
  }
  if (!stopping) throw new Error('Vite did not become ready in 30 seconds');
}
run().catch(error => { console.error(error.message); shutdown(1); });
