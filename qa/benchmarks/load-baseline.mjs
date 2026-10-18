import { startChatBackend } from './chat-backend.mjs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const require = createRequire(path.join(root, 'server/package.json'));
const WebSocket = require('ws');
const output = path.join(root, 'test-results/load-baseline');
const rows = [];
const percentile = (values, p) => values.length ? +[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)].toFixed(2) : null;
async function phase(name, concurrency, operation) {
  const samples=[], errors={}; let count=0, success=0;
  const began=performance.now(); const until=began+8000;
  await Promise.all(Array.from({length:concurrency}, async (_,worker)=>{
    while(performance.now()<until && count<2000) {
      const sequence=count++; const start=performance.now();
      try { await operation(worker,sequence); success++; samples.push(performance.now()-start); }
      catch(e) { const key=e.message.slice(0,100); errors[key]=(errors[key]||0)+1; }
    }
  }));
  const seconds=(performance.now()-began)/1000;
  const result={name,concurrency,requests:count,success,errors,seconds:+seconds.toFixed(2),successfulPerSecond:+(success/seconds).toFixed(2),errorRate:+((count-success)/count*100).toFixed(2),p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95),p99Ms:percentile(samples,.99)};
  rows.push(result); console.log(JSON.stringify(result));
}
let backend; const sockets=[];
try {
  console.log('Starting isolated backend and seeding test data');
  backend=await startChatBackend(root);
  const read=async()=>{const r=await fetch(`${backend.base}/api/chat/v1/message/chat_list`,{headers:{Authorization:`Bearer ${backend.auth.token}`},signal:AbortSignal.timeout(10000)});const b=await r.json();if(!r.ok||b.code!==200||!Array.isArray(b.data)||b.data.length!==10)throw Error(`HTTP ${r.status}, code ${b.code}`);};
  for(let i=0;i<10;i++)await read();
  for(const n of [1,10,50,100])await phase('conversation-list',n,read);
  for(const n of [1,10,50,100]) {
    console.log(`Opening ${n} WebSockets`);
    const room=backend.rooms[0];
    const peers=await Promise.all(Array.from({length:n},()=>new Promise((resolve,reject)=>{
      const ws=new WebSocket(`${backend.base.replace('http:','ws:')}/api/chat/v1/message/connect_chat?room=${encodeURIComponent(room.room)}&id=${backend.auth.info.id}&type=private`,['pomelo-token',backend.auth.token]);sockets.push(ws);
      const timer=setTimeout(()=>reject(Error('WS history timeout')),10000);
      ws.on('error',reject);ws.on('message',raw=>{const frame=JSON.parse(raw);if(frame.name==='history'){clearTimeout(timer);resolve(ws)}});
    })));
    await phase('message-ack',n,(worker,sequence)=>new Promise((resolve,reject)=>{
      const ws=peers[worker],id=`load-${n}-${worker}-${sequence}`;
      const done=(error)=>{clearTimeout(timer);ws.off('message',receive);error?reject(error):resolve();};
      const receive=raw=>{const frame=JSON.parse(raw);if(frame.name==='ack' && frame.client_msg_id===id)done();else if(frame.name==='error')done(Error(`WS error ${frame.code||frame.message||'rejected'}`));};
      const timer=setTimeout(()=>done(Error('ACK timeout')),10000);ws.on('message',receive);
      ws.send(JSON.stringify({sender_id:backend.auth.info.id,receiver_id:room.receiver_id,content:id,type:'text',clientMsgId:id}));
    }));
    for(const ws of peers)ws.terminate();
  }
} catch(e) {console.error(e.message);rows.push({fatal:e.message});process.exitCode=1;}
finally {
  for(const ws of sockets)ws.terminate();
  if(backend)await backend.close();
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'report.json'),JSON.stringify({date:new Date().toISOString(),apiRateLimitMax:Number(process.env.API_RATE_LIMIT_MAX||240),node:process.version,platform:process.platform,scope:'Local isolated backend; shared authenticated account; 10 private rooms, initially 60 messages; WS same room broadcast fanout; closed-loop bounded 8s/2000 requests per phase; success-only latency; no paid AI/RTC; not capacity limit',rows},null,2));
  await writeFile(path.join(output,'report.md'),'# Local load baseline\n\nShared test account, isolated MySQL database and Redis prefix. Closed-loop load, up to 8 seconds or 2000 attempts per phase. Latency measures successful operations only. WS clients share one room: broadcast fanout is included. This is not a production capacity claim.\n\n| Scenario | Concurrency | Attempts | Success/s | Error % | P95 ms | P99 ms |\n|---|---:|---:|---:|---:|---:|---:|\n'+rows.map(r=>r.fatal?`Fatal: ${r.fatal}`:`| ${r.name} | ${r.concurrency} | ${r.requests} | ${r.successfulPerSecond} | ${r.errorRate} | ${r.p95Ms} | ${r.p99Ms} |`).join('\n')+'\n\nSee report.json for errors and elapsed durations. Test fixtures are cleaned up on completion.\n');
}
