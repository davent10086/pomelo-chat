const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../../client/node_modules/typescript');
const { clampBounds, dockBounds } = require('../geometry.cjs');
const { validAuth, validChat, trustedFrame } = require('../protocol.cjs');
const compiled = ts.transpileModule(fs.readFileSync(require.resolve('../../client/src/desktop/motion.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
});
const mod = { exports: {} };
new Function('exports', 'module', compiled.outputText)(mod.exports, mod);
const { AssistantMotion } = mod.exports;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('dock follows the main window and stays inside negative-origin/small displays', () => {
 const area = { x: -1920, y: -100, width: 1920, height: 1080 };
 for (const expanded of [true, false]) {
  const result = dockBounds({ x: -400, y: 200, width: 1200, height: 800 }, area, expanded);
  assert.equal(result.assistant.x, result.main.x + result.main.width);
  assert.equal(result.assistant.width, expanded ? 360 : 40);
  assert.equal(result.assistant.height, expanded ? result.main.height : 96);
  assert(result.assistant.x + result.assistant.width <= area.x + area.width);
  if (expanded) assert.equal(result.assistant.y, result.main.y);
 }
 const small = dockBounds({ x: 100, y: 100, width: 1200, height: 800 }, { x: 0, y: 0, width: 1024, height: 600 }, true);
 assert.equal(small.main.width, 664); assert.equal(small.assistant.height, 600);
 assert.deepEqual(clampBounds({ x: -5000, y: 5000, width: 380, height: 560 }, { x: 0, y: 0, width: 320, height: 400 }),
  { x: 0, y: 0, width: 320, height: 400 });
});

test('IPC rejects malformed data, foreign origins, subframes and wrong window roles', () => {
  assert.equal(validAuth(null), true);
  assert.equal(validAuth({ token: 'x', user: { id: -1 } }), false);
  assert.equal(validChat({ room: 'ai_1', type: 'private', receiverId: 2, name: 'AI' }), false);
  assert.equal(validChat({ room: 'private_1_2', type: 'private', receiverId: 2, name: '同事' }), true);
  assert.equal(validChat({ room: 'g', type: 'group', receiverId: '2', name: '群' }), false);
  const frame = { url: 'http://127.0.0.1:5173/desktop-assistant' };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(trustedFrame(event, window, 'http://127.0.0.1:5173', 'assistant'), true);
  assert.equal(trustedFrame(event, window, 'http://127.0.0.1:5173', 'main'), false);
  assert.equal(trustedFrame({ ...event, senderFrame: { ...frame } }, window, 'http://127.0.0.1:5173', 'assistant'), false);
  frame.url = 'https://example.com/desktop-assistant';
  assert.equal(trustedFrame(event, window, 'http://127.0.0.1:5173', 'assistant'), false);
});

test('rapid expand/collapse/expand never lets an old completion shrink the window', async () => {
  const events = [], animations = [];
  const controller = new AssistantMotion({
    resize: async (expanded, ticket) => { events.push(['resize', expanded, ticket]); },
    phase: phase => events.push(['phase', phase]), error: error => { throw error; },
    animate: expanded => {
      const pending = deferred(); animations.push(pending);
      return { finished: pending.promise, cancel: pending.resolve };
    }
  });
  const first = controller.setExpanded(true); await flush();
  const second = controller.setExpanded(false); await flush();
  const third = controller.setExpanded(true); await flush();
  animations.at(-1).resolve();
  await Promise.all([first, second, third]);
  assert.equal(controller.targetExpanded, true);
  assert.equal(events.some(event => event[0] === 'resize' && event[1] === false), false);
  assert.deepEqual(events.at(-1), ['phase', 'expanded']);
});

test('collapse waits for animation; logout reset cancels pending completion', async () => {
  const events = [], pending = deferred();
  const controller = new AssistantMotion({
    resize: async expanded => events.push(expanded), phase: phase => events.push(phase), error: error => { throw error; },
    animate: () => ({ finished: pending.promise, cancel: pending.resolve })
  });
  const collapse = controller.setExpanded(false); await flush();
  assert.deepEqual(events, ['collapsing']);
  pending.resolve(); await collapse;
  assert.deepEqual(events, ['collapsing', false, 'collapsed']);
  const other = deferred();
  const resetEvents = [];
  const reset = new AssistantMotion({
    resize: async expanded => resetEvents.push(expanded), phase: phase => resetEvents.push(phase), error: () => {},
    animate: () => ({ finished: other.promise, cancel: other.resolve })
  });
  const run = reset.setExpanded(true); await flush(); reset.reset(); await run;
  assert.deepEqual(resetEvents.at(-1), 'collapsed');
  assert.equal(reset.targetExpanded, false);
});
