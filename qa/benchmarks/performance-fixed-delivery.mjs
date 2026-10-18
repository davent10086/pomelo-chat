import { startChatBackend } from './chat-backend.mjs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(path.resolve('server/package.json')),WS=require('ws');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const samples=[],errors={},sockets=[],pending=new Map(),seen=new Set();
let backend,attempts=0,success=0,duplicates=0,orderErrors=0,finished=false;
const lastSeq=new Map();
async function connect(auth,room){return new Promise((resolve,reject)=>{
 const ws=new WS(`${backend.base.replace('http:','ws:')}/api/chat/v1/message/connect_chat?room=${encodeURIComponent(room)}&id=${auth.info.id}&type=private`,['pomelo-token',auth.token]);sockets.push(ws);
 const timer=setTimeout(()=>reject(Error('connect timeout')),10000);ws.on('error',reject);
 ws.on('message',raw=>{const f=JSON.parse(raw);if(f.name==='history'){clearTimeout(timer);resolve(ws);return;}
  if(!f.client_msg_id?.startsWith('soak-'))return;
  const key=f.client_msg_id,p= pending.get(key);
  if(f.name==='ack'){if(p){p.ack=true;p.finish();}return;}
  if(f.name==='error'){if(p)p.fail(Error(f.message));return;}
  if(f.id && f.sender_id!==auth.info.id){
   if(seen.has(key)){duplicates++;return;}seen.add(key);
   const previous=lastSeq.get(room)||0;if(Number(f.room_seq)<=previous)orderErrors++;lastSeq.set(room,Number(f.room_seq));
   if(p){p.delivery=true;p.finish();}
  }
 });
});}
try{
 backend=await startChatBackend(process.cwd());const clients=await backend.createIndependentPeers(50,true);
 const peers=[];for(const c of clients)peers.push({c,a:await connect(c.auth,c.room.room),b:await connect(c.receiverAuth,c.room.room)});
 console.log('50 private rooms, 100 distinct accounts and live WebSockets ready; running 60 seconds');
 const began=performance.now(),until=began+60000;
 const ticker=setInterval(()=>console.log(JSON.stringify({elapsedSeconds:Math.round((performance.now()-began)/1000),attempts,success,received:seen.size,errors})),15000);
 await Promise.all(peers.map(async({c,a,b},worker)=>{
 let sequence=0;while(performance.now()<until){
  const reverse=sequence%2===1,auth=reverse?c.receiverAuth:c.auth,ws=reverse?b:a;
  const key=`soak-${worker}-${sequence++}`,start=performance.now();attempts++;
  try{await new Promise((resolve,reject)=>{
   let ack=false,delivery=false;const timer=setTimeout(()=>finish(Error('ACK or delivery timeout')),15000);
   const finish=error=>{clearTimeout(timer);pending.delete(key);error?reject(error):resolve();};
   const p={ack,delivery,finish(){if(this.ack&&this.delivery)finish();},fail:finish};pending.set(key,p);
   ws.send(JSON.stringify({content:key,type:'text',clientMsgId:key}));
  });success++;samples.push(performance.now()-start);}catch(e){errors[e.message]=(errors[e.message]||0)+1;}
  await sleep(100);
 }
 }));clearInterval(ticker);finished=true;
 console.log(JSON.stringify({attempts,success,received:seen.size,duplicates,orderErrors,backendErrors:backend.messageErrorTypes}));
}catch(e){errors.fatal=e.message;console.error(e.message);process.exitCode=1;}
finally{
 for(const ws of sockets)ws.terminate();if(backend)await backend.close();
 samples.sort((a,b)=>a-b);const pct=p=>samples.length?+samples[Math.min(samples.length-1,Math.ceil(samples.length*p)-1)].toFixed(2):null;
 const result={durationTargetSeconds:60,rooms:50,liveAccounts:100,finished,attempts,success,receivedUnique:seen.size,duplicates,orderErrors,errors,p50Ms:pct(.5),p95Ms:pct(.95),p99Ms:pct(.99),backendErrors:backend?.messageErrorTypes,limitations:'Local loopback; 100ms think time; one in-flight message per room; alternates direction; ACK plus recipient delivery; no restarts during load; not a capacity or long soak test'};
 await mkdir('test-results/performance-fixed-2026-10-18',{recursive:true});await writeFile('test-results/performance-fixed-2026-10-18/online-soak.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));if(!finished||success!==attempts||seen.size!==success||orderErrors)process.exitCode=1;
}
