import { startChatBackend } from './chat-backend.mjs';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(path.resolve('server/package.json'));
const WS = require('ws'), exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve('test-results', `comprehensive-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const rows = [], resources = [], sockets = [], anomalies = { duplicates: 0, orderErrors: 0, unexpectedCloses: 0 };
const duration = Number(process.env.SOAK_SECONDS || 180);
const followup = process.env.LOAD_PROFILE === 'followup';
let groupEvidence;
let backend, phaseName = 'setup', resourceBusy = false, sampler;
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
const pct = (v,p) => v.length ? +[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1].toFixed(2) : null;
const fail = (condition, message) => { if (!condition) throw Error(message); };
async function api(route, token, body) {
  const response = await fetch(`${backend.base}/api/chat/v1/${route}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {}) },
    ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.timeout(15000)
  });
  const json = await response.json();
  fail(response.ok && json.code === 200, `API ${route.split('?')[0]}: ${response.status}/${json.code}`);
  return json.data;
}
async function phase(name, concurrency, seconds, operation, limit = Infinity, thinkTimeMs = 0) {
  phaseName = name; const samples = [], errors = {}; let attempts = 0, success = 0;
  const start = performance.now(), until = start + seconds*1000;
  await Promise.all(Array.from({length: concurrency}, async (_,worker) => {
    while (performance.now() < until && attempts < limit) {
      const sequence = attempts++, began = performance.now();
      try { await operation(worker,sequence); success++; samples.push(performance.now()-began); }
      catch(e) { errors[e.message] = (errors[e.message] || 0)+1; }
      if(thinkTimeMs)await sleep(thinkTimeMs);
    }
  }));
  const elapsed = (performance.now()-start)/1000;
  const row = {name,concurrency,thinkTimeMs,seconds:+elapsed.toFixed(2),attempts,success,errors,successPerSecond:+(success/elapsed).toFixed(2),p50Ms:pct(samples,.5),p95Ms:pct(samples,.95),p99Ms:pct(samples,.99)};
  rows.push(row); console.log(JSON.stringify(row)); await save(); return row;
}
async function connect(auth, room, type='private') {
  return new Promise((resolve,reject) => {
    const ws = new WS(`${backend.base.replace('http:','ws:')}/api/chat/v1/message/connect_chat?room=${encodeURIComponent(room)}&id=${auth.info.id}&type=${type}`, ['pomelo-token',auth.token]);
    const peer = {ws,auth,room,pending:new Map(),seen:new Set(),lastSeq:0,frames:0,expectedClose:false}; sockets.push(peer);
    const timer = setTimeout(()=>{ws.terminate();reject(Error('connect/history timeout'));},15000);
    ws.on('error', e=>{clearTimeout(timer);reject(e);});
    ws.on('close',()=>{if(!peer.expectedClose)anomalies.unexpectedCloses++; for(const p of peer.pending.values())p.reject(Error('socket closed'));peer.pending.clear();});
    ws.on('message',raw=>{
      const frame = JSON.parse(raw);
      if(frame.name === 'history'){clearTimeout(timer);peer.history=frame;resolve(peer);return;}
      const pending = peer.pending.get(frame.client_msg_id);
      if(frame.name === 'ack' || frame.name === 'error') {
        if(pending) {peer.pending.delete(frame.client_msg_id); frame.name === 'ack' ? pending.resolve(frame) : pending.reject(Error(frame.message));}
        return;
      }
      if(frame.id && frame.client_msg_id?.startsWith('full-')) {
        if(peer.seen.has(frame.client_msg_id))anomalies.duplicates++;
        else {peer.seen.add(frame.client_msg_id);peer.frames++;if(Number(frame.room_seq)<=peer.lastSeq)anomalies.orderErrors++;peer.lastSeq=Number(frame.room_seq);}
      }
    });
  });
}
function send(peer,id,content=id) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{peer.pending.delete(id);reject(Error('ACK timeout'));},15000);
    peer.pending.set(id,{resolve:f=>{clearTimeout(timer);resolve(f);},reject:e=>{clearTimeout(timer);reject(e);}});
    peer.ws.send(JSON.stringify({content,type:'text',clientMsgId:id}));
  });
}
async function waitFor(check,label) {
  const until=performance.now()+15000;
  while(!check()){if(performance.now()>until)throw Error(label);await sleep(5);}
}
function close(peer){peer.expectedClose=true;peer.ws.terminate();}
async function sampleResources() {
  if(resourceBusy || !backend)return;resourceBusy=true;
  try {
    const record={time:new Date().toISOString(),phase:phaseName,freeMemoryMiB:Math.round(os.freemem()/1048576),generatorRssMiB:Math.round(process.memoryUsage().rss/1048576),generatorLoopP99Ms:+(eventLoop.percentile(99)/1e6).toFixed(2)};
    eventLoop.reset();
    if(process.platform==='win32') {
      const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${backend.backendPid} | Select-Object CPU,WorkingSet64,PrivateMemorySize64,Handles | ConvertTo-Json -Compress`],{windowsHide:true,timeout:8000});
      record.backend=JSON.parse(stdout);
    }
    resources.push(record);
  } catch(e){resources.push({phase:phaseName,samplingError:e.message});}
  finally{resourceBusy=false;}
}
async function save(extra={}) {
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'report.json'),JSON.stringify({date:new Date().toISOString(),node:process.version,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemoryGiB:+(os.totalmem()/1073741824).toFixed(2),scope:'Single-machine loopback; load generator, backend, MySQL and Redis share hardware. Closed-loop load; success-only percentiles. Paid AI and RTC disabled. Rate limiter raised only in isolated child. Not a production capacity estimate.',soakTargetSeconds:duration,rows,anomalies,groupEvidence,backendErrors:backend?.messageErrorTypes,resources,...extra},null,2));
}
try {
  process.env.API_RATE_LIMIT_MAX='1000000';
  backend=await startChatBackend(process.cwd());
  sampler=setInterval(()=>void sampleResources(),5000);await sampleResources();
  const clients=await backend.createIndependentPeers(followup ? 50 : 200,true);
  console.log(`Ready: ${clients.length*2} accounts, ${clients.length} private rooms`);
  if(!followup)for(const n of [50,200,400])await phase('conversation-list',n,15,w=>api('message/chat_list',clients[w%200].auth.token));
  const peers=[];
  for(let i=0;i<clients.length;i+=20)peers.push(...await Promise.all(clients.slice(i,i+20).map(async c=>({a:await connect(c.auth,c.room.room),b:await connect(c.receiverAuth,c.room.room),c}))));
  if(!followup){
  await phase('idle-400-sockets',1,20,async()=>{await sleep(1000);await api('message/chat_list',clients[0].auth.token);});
  for(const n of [10,50,100,200])await phase('ack-plus-recipient',n,15,async(w,s)=>{
    const p=peers[w],id=`full-delivery-${n}-${s}`;await send(p.a,id);await waitFor(()=>p.b.seen.has(id),'recipient timeout');
  });
  await phase('mixed-search-history-send',100,20,async(w,s)=>{
    const p=peers[w];
    if(s%3===0)await api(`message/search?room=${p.c.room.room}&type=private&query=full&limit=20`,p.c.auth.token);
    else if(s%3===1)await api(`message/history?room=${p.c.room.room}&type=private&limit=30`,p.c.auth.token);
    else {const id=`full-mixed-${s}`;await send(p.a,id);await waitFor(()=>p.b.seen.has(id),'mixed delivery timeout');}
  });
  await phase('duplicate-idempotency',50,15,async(w,s)=>{
    const id=`full-duplicate-${s}`,p=peers[w];const a=await send(p.a,id),b=await send(p.a,id);fail(a.id===b.id,'duplicate persisted twice');
  },1000);
  await phase('reconnect-history',50,15,async(w)=>{
    const p=peers[w];close(p.b);p.b=await connect(p.c.receiverAuth,p.c.room.room);
    fail(Array.isArray(p.b.history.messages),'invalid recovery history');
  },300);
  }
  if(followup && Number(process.env.PRIME_MESSAGES || 0)>0) {
    await phase('history-prime-real-message-writes',50,120,async(w,s)=>{await send(peers[w].a,`full-prime-${s}`);},Number(process.env.PRIME_MESSAGES));
  }
  const owner=clients[0].auth;
  for(const c of clients.slice(1,50))await api('friend/add_friend',owner.token,{id:c.auth.info.id,username:c.auth.info.username});
  await api('group/create_group',owner.token,{name:'Stress hot group',avatar:'',members:clients.slice(1,50).map(c=>({user_id:c.auth.info.id,username:c.auth.info.username}))});
  const groups=await api('group/group_list',owner.token),group=groups.find(g=>g.name==='Stress hot group');fail(group,'group missing');
  const groupPeers=await Promise.all(clients.slice(0,50).map(c=>connect(c.auth,group.room,'group')));
  const sentGroupIds=new Set();
  await phase('hot-group-20-writers-50-recipients',20,20,async(w,s)=>{const id=`full-group-${s}`;await send(groupPeers[w],id);sentGroupIds.add(id);});
  const drainStarted=performance.now();
  groupEvidence={atSendStop:await backend.auditMessages(),progress:[]};
  phaseName='group-backlog-drain';
  while(!groupPeers.every(p=>[...sentGroupIds].every(id=>p.seen.has(id))) && performance.now()-drainStarted<120000){
    const snapshot={elapsedSeconds:Math.round((performance.now()-drainStarted)/1000),expectedPerRecipient:sentGroupIds.size,minReceived:Math.min(...groupPeers.map(p=>p.seen.size)),maxReceived:Math.max(...groupPeers.map(p=>p.seen.size)),audit:await backend.auditMessages()};
    groupEvidence.progress.push(snapshot);console.log(JSON.stringify({groupDrain:snapshot}));await save();await sleep(5000);
  }
  groupEvidence.drainSeconds=+( (performance.now()-drainStarted)/1000).toFixed(2);
  groupEvidence.final=await backend.auditMessages();
  groupEvidence.complete=groupPeers.every(p=>[...sentGroupIds].every(id=>p.seen.has(id)));
  rows.push({name:'group-delivery-integrity',messages:sentGroupIds.size,recipients:50,expectedDeliveries:sentGroupIds.size*50,received:groupPeers.reduce((n,p)=>n+p.seen.size,0)});
  await save();
  for(const p of groupPeers)close(p);
  await phase('concurrent-1MiB-upload-download',10,20,async(w,s)=>{
    const token=clients[w].auth.token,bytes=randomBytes(1048576),fileHash=createHash('sha256').update(bytes).digest('hex');
    const verified=await api('file/verify_file',token,{fileHash,totalCount:1,extname:'txt'});
    const form=new FormData();form.append('chunk',new Blob([bytes]));form.append('chunkIndex','1');form.append('fileHash',fileHash);form.append('extname','txt');form.append('uploadToken',verified.uploadToken);
    const response=await fetch(`${backend.base}/api/chat/v1/file/upload_chunk`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(15000)});
    fail(response.ok && (await response.json()).code===200,'chunk upload failed');
    const merged=await api('file/merge_chunk',token,{fileHash,extname:'txt',uploadToken:verified.uploadToken});
    const downloaded=await fetch(backend.base+merged.filePath,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
    fail(downloaded.ok,'download denied');fail(createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex')===fileHash,'download checksum mismatch');
  },30);
  await phase('sustained-bidirectional-50-rooms',50,duration,async(w,s)=>{
    const p=peers[w],reverse=s%2===1,id=`full-soak-${s}`,sender=reverse?p.b:p.a,receiver=reverse?p.a:p.b;
    await send(sender,id);await waitFor(()=>receiver.seen.has(id),'soak recipient timeout');
  },Infinity,50);
  await phase('offline-history-recovery',20,20,async(w,s)=>{
    const p=peers[w];close(p.b);const id=`full-offline-${s}`;await send(p.a,id);
    p.b=await connect(p.c.receiverAuth,p.c.room.room);
    fail(p.b.history.messages.some(m=>m.client_msg_id===id),'offline message absent from recovery history');
  },40);
  await sleep(1000);const audit=await backend.auditMessages();
  fail(audit.sequenceErrors.length===0 && audit.statisticsErrors.length===0,'database sequence/statistics audit failed');
  fail(Number(audit.pendingOutbox)===0,'delivery backlog did not drain');
  fail(groupEvidence.complete,'group fanout incomplete after 120 seconds');
  fail(!Object.values(anomalies).some(Boolean),'delivery anomaly detected');
  fail(rows.every(r=>!r.errors || Object.keys(r.errors).length===0),'one or more load phases failed');
  await save({audit,completed:true});console.log(JSON.stringify({completed:true,audit,anomalies,output}));
} catch(e) {console.error(e.stack);await save({completed:false,fatal:e.message,audit:backend ? await backend.auditMessages().catch(()=>null) : null});process.exitCode=1;}
finally {clearInterval(sampler);eventLoop.disable();for(const p of sockets)close(p);if(backend)await backend.close();console.log(`Report: ${output}`);}
