// Loaded only in the isolated benchmark process after ts-node registration.
const fs = require('fs');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { AsyncLocalStorage } = require('async_hooks');
const scope = new AsyncLocalStorage();
const db = require(process.cwd() + '/src/infrastructure/database.ts').default;
const writes = require(process.cwd() + '/src/modules/messaging/writes.ts');
const metrics = {};
const record = (key, duration) => { const m = metrics[key] ||= {count:0,totalMs:0,maxMs:0}; m.count++;m.totalMs+=duration;m.maxMs=Math.max(m.maxMs,duration); };
const originalGet = db.getConnection.bind(db);
db.getConnection = callback => { const began=performance.now(),context=scope.getStore()||'other'; originalGet((error,connection)=>{
 record(context+':pool-wait',performance.now()-began);
 if(connection&&!connection.__profiled){ connection.__profiled=true;const query=connection.query.bind(connection);connection.query=(...args)=>{const start=performance.now(),ctx=scope.getStore()||'other';const sql=typeof args[0]==='string'?args[0]:args[0]?.sql||'';const label=sql.replace(/\s+/g,' ').replace(/\?.*/,'?').slice(0,105);const callback=args[args.length-1];if(typeof callback==='function')args[args.length-1]=function(...values){record(ctx+':sql:'+label,performance.now()-start);return callback.apply(this,values);};return query(...args);}; }
 callback(error,connection);
 });};
if(process.env.PROFILE_POOL_SIZE)db.config.connectionLimit=Number(process.env.PROFILE_POOL_SIZE);
if(process.env.PROFILE_NO_OUTBOX==='1')require(process.cwd()+'/src/modules/messaging/outbox.ts').enableMessageOutbox=()=>{};
if(process.env.PROFILE_LOOKUP_CONVERSATION==='1'){
 const repository=require(process.cwd()+'/src/modules/messaging/repository.ts');const ensure=repository.ensureWriteConversation;
 repository.ensureWriteConversation=async(bindings,query)=>{const rows=await query('SELECT id FROM conversation WHERE room = ?',[bindings[0]]);if(!rows.length)return ensure(bindings,query);return {};};
}
for(const [file,name,label] of [['/src/modules/social/permissions.ts','authorizeChatRoom','room-authorization'],['/src/modules/realtime/session-sockets.ts','validateSessionSocket','session-check']]){
 const module=require(process.cwd()+file),original=module[name];module[name]=async(...args)=>{const start=performance.now();try{return await original(...args);}finally{record(label,performance.now()-start);}};
}
const originalWrite=writes.writeAndSend;
writes.writeAndSend=(...args)=>scope.run('message',async()=>{const began=performance.now();try{return await originalWrite(...args);}finally{record('message:total',performance.now()-began);}});
const delay=monitorEventLoopDelay({resolution:10});delay.enable();
let previousCpu=process.cpuUsage(),previousTime=performance.now();const resources=[];
const save=()=>{const now=performance.now(),cpu=process.cpuUsage();resources.push({cpuOneCorePercent:+(((cpu.user-previousCpu.user+cpu.system-previousCpu.system)/1000)/(now-previousTime)*100).toFixed(1),rssMiB:+(process.memoryUsage().rss/2**20).toFixed(1),poolQueue:db._connectionQueue.length,poolConnections:db._allConnections.length,eventLoopP99Ms:+(delay.percentile(99)/1e6).toFixed(2)});previousCpu=cpu;previousTime=now;delay.reset();fs.writeFileSync(process.env.PROFILE_OUTPUT,JSON.stringify({poolLimit:db.config.connectionLimit,noOutbox:process.env.PROFILE_NO_OUTBOX==='1',metrics,resources},null,2));};
setInterval(save,1000).unref();
