// Loaded only by the isolated multi-instance test. No production route or runtime switch.
if (process.env.NODE_ENV !== 'test' || !process.env.REDIS_KEY_PREFIX?.startsWith('benchmark:'))
  throw new Error('Fanout diagnostics require isolated benchmark targets');
const { better_chat } = require('../../../server/src/infrastructure/redis');
const duplicate = better_chat.duplicate.bind(better_chat);
process.once('SIGTERM', () => { if (process.connected) process.disconnect(); });
let subscriber;
better_chat.duplicate = (...args) => {
  const client = duplicate(...args), subscribe = client.subscribe.bind(client);
  client.subscribe = (...channels) => {
    if (channels.includes(`${process.env.REDIS_KEY_PREFIX}pomelo:message:fanout`)) subscriber = client;
    return subscribe(...channels);
  };
  return client;
};
process.on('message', async message => {
  if (!message?.requestId || !message.type?.startsWith('benchmark:')) return;
  try {
    if (!subscriber) throw new Error('Message subscriber not ready');
    if (message.type === 'benchmark:pause-worker') await require('../../../server/src/modules/messaging/outbox').stopMessageOutbox();
    else if (message.type === 'benchmark:resume-worker') await require('../../../server/src/modules/realtime/message-delivery').startMessageDelivery();
    else if (message.type === 'benchmark:pause-fanout') subscriber.disconnect();
    else if (message.type === 'benchmark:resume-fanout') await subscriber.connect();
    else throw new Error('Unknown diagnostic command');
    process.send({ requestId: message.requestId, result: { status: subscriber.status, pid: process.pid } });
  } catch (error) { process.send({ requestId: message.requestId, error: error.message }); }
});
