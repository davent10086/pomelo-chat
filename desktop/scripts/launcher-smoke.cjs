const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const assert = require('node:assert/strict');
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function launcherSmoke() {
  if (process.platform !== 'win32') return;
  const runner = spawn(process.execPath, [path.join(__dirname, 'dev.cjs')], {
    cwd: path.resolve(__dirname, '../..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, POMELO_DESKTOP_PORT: '5189', POMELO_SERVER_URL: 'http://127.0.0.1:9' }
  });
  let output = '';
  runner.stdout.on('data', chunk => { output += chunk; });
  runner.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => runner.once('exit', resolve));
  try {
    for (let i = 0; i < 150 && !output.includes('Desktop: http://127.0.0.1:5189'); i++) {
      if (runner.exitCode !== null) throw new Error(`Launcher exited: ${output}`);
      if (i === 149) throw new Error(`Launcher readiness timeout: ${output}`);
      await pause(200);
    }
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${runner.pid}' | Where-Object { $_.Name -eq 'electron.exe' } | Select-Object -ExpandProperty ProcessId`
    ], { windowsHide: true });
    const pid = Number(stdout.trim());
    assert(Number.isSafeInteger(pid) && pid > 0, 'launcher owns a real Electron child');
    // Electron exit must cause the launcher to tear down its Vite tree.
    process.kill(pid);
    await Promise.race([exited, pause(8000).then(() => { throw new Error('Launcher did not exit after Electron'); })]);
    await assert.rejects(fetch('http://127.0.0.1:5189', { signal: AbortSignal.timeout(500) }));
    console.log('[desktop-launcher] startup and owned child cleanup passed');
  } finally {
    if (runner.exitCode === null) {
      await exec('taskkill.exe', ['/pid', String(runner.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      await exited;
    }
  }
};
