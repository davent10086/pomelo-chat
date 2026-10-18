process.env.TS_NODE_PROJECT = require('node:path').join(process.cwd(), 'server', 'tsconfig.json');
process.env.JWT_SECRET = 'session-regression-only-secret';
require('../../server/node_modules/ts-node/register/transpile-only');
const {createRequire} = require('node:module');
const req = createRequire(require('node:path').join(process.cwd(), 'server', 'package.json'));
const jwt = req('jsonwebtoken');
const assert = require('node:assert/strict');
const test = require('node:test');
const {verifyToken, verifyTokenWithSession} = require('../../server/src/modules/identity/session');
const {better_chat} = require('../../server/src/infrastructure/redis');
test('parsed JWT key preserves signature, expiry and supported HMAC verification', () => {
 for(const algorithm of ['HS256','HS384','HS512']){
  const token = jwt.sign({id:1,username:'tester'},process.env.JWT_SECRET,{algorithm,expiresIn:60});
  assert.equal(verifyToken(token).username,'tester');
  assert.equal(verifyToken('Bearer '+token).id,1);
 }
 assert.equal(verifyToken(jwt.sign({id:1},'different-secret')),null);
 assert.equal(verifyToken(jwt.sign({id:1},process.env.JWT_SECRET,{expiresIn:-1})),null);
 assert.equal(verifyToken('invalid.token'),null);
 assert.equal(verifyToken(jwt.sign({id:1,username:'tester'},process.env.JWT_SECRET,{notBefore:60})),null);
 assert.equal(verifyToken(jwt.sign({id:1,username:'tester'},'',{algorithm:'none'})),null);
 assert.equal(verifyToken(jwt.sign({username:'tester'},process.env.JWT_SECRET)),null);
});
test('Redis failures reject sessions instead of using a cached authentication result',async()=>{
 const token=jwt.sign({id:1,username:'tester'},process.env.JWT_SECRET);
 const original=better_chat.get;
 const originalError=console.error;
 better_chat.get=async()=>{throw new Error('simulated Redis outage');};
 console.error=()=>{};
 try{assert.equal(await verifyTokenWithSession(token),null);}finally{better_chat.get=original;console.error=originalError;}
});
test('every session check consults Redis so revocation is immediate',async()=>{
 const token=jwt.sign({id:1,username:'tester'},process.env.JWT_SECRET);
 const original=better_chat.get;let current=token,calls=0;
 better_chat.get=async()=>{calls++;return current;};
 try{assert.equal((await verifyTokenWithSession(token)).id,1);current=null;assert.equal(await verifyTokenWithSession(token),null);assert.equal(calls,2);}finally{better_chat.get=original;}
});
