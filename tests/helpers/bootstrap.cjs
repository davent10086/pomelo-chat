const path = require('node:path');
const { serverRoot } = require('./paths.cjs');
process.env.TS_NODE_PROJECT = path.join(serverRoot, 'tsconfig.json');
if (process.env.TEST_LAYER === 'unit') {
  // Unit isolation is enforced, not merely a convention or an unavailable local service.
  const net = require('node:net');
  net.Socket.prototype.connect = function () { throw new Error('Unit tests must not open network connections; move this case to integration'); };
  global.fetch = async () => { throw new Error('Unit tests must not call external HTTP services'); };
}
if (['integration', 'e2e', 'qa'].includes(process.env.TEST_LAYER)) {
  // Default integration covers our RTC state machine and retry queue. Real media
  // and SDK/SFU contracts are exercised only by the explicit RTC suite.
  const { serverRequire } = require('./paths.cjs');
  const { RoomServiceClient } = serverRequire('livekit-server-sdk');
  RoomServiceClient.prototype.createRoom = async () => ({});
  RoomServiceClient.prototype.deleteRoom = async () => undefined;
}
