const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');

const stopTree = async child => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else {
    // Capture descendants before terminating their parent; detached web servers
    // may have their own process group, so killing only our group is insufficient.
    const listing = await new Promise(resolve => execFile('ps', ['-eo', 'pid=,ppid='], { timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout)));
    const rows = listing.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
    const owned = new Set([child.pid]);
    let changed;
    do { changed = false; for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; } } while (changed);
    const terminate = signal => {
      for (const pid of [...owned].reverse()) { try { process.kill(pid, signal); } catch {} }
      try { process.kill(-child.pid, signal); } catch {}
    };
    terminate('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));
    terminate('SIGKILL');
  }
};

/** Parent owns the entire process tree, including Playwright web servers. */
const runProcess = (command, args, { cwd, env, logPath, timeoutMs = 300000, signal, quiet = false } = {}) => new Promise(resolve => {
  const started = Date.now(), stream = logPath ? fs.createWriteStream(logPath) : undefined;
  let output = '', timedOut = false, interrupted = false, spawnError, stopping;
  const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const receive = data => { const text = data.toString(); output = (output + text).slice(-2 * 1024 * 1024); stream?.write(data); if (!quiet) process.stdout.write(data); };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  const stop = () => stopping ||= stopTree(child);
  const abort = () => { interrupted = true; void stop(); };
  const timer = setTimeout(() => { timedOut = true; void stop(); }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.on('error', error => { spawnError = error.code || error.message; });
  child.on('close', async (code, childSignal) => {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await stopping;
    if (stream) await new Promise(done => stream.end(done));
    resolve({ status: interrupted ? 'interrupted' : timedOut ? 'timedOut' : code === 0 && !spawnError ? 'passed' : 'failed',
      exitCode: code, signal: childSignal, error: spawnError, durationMs: Date.now() - started, output, logPath });
  });
});
module.exports = { runProcess, stopTree };
