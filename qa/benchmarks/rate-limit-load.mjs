import { startChatBackend } from './chat-backend.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
process.env.API_RATE_LIMIT_MAX='240';
let backend;
try {
  backend=await startChatBackend(process.cwd());
  const statuses={},codes={};let attempted=0,retryAfter=0;
  await Promise.all(Array.from({length:20},async()=>{
    while(attempted<300){attempted++;
      const response=await fetch(backend.base+'/api/chat/v1/message/chat_list',{headers:{Authorization:`Bearer ${backend.auth.token}`},signal:AbortSignal.timeout(15000)});
      const body=await response.json();statuses[response.status]=(statuses[response.status]||0)+1;codes[body.code]=(codes[body.code]||0)+1;
      if(response.status===429 && Number(response.headers.get('Retry-After'))>0)retryAfter++;
    }
  }));
  const result={attempted,statuses,codes,limitedWithRetryAfter:retryAfter,passed:(statuses[200]||0)>0 && (statuses[429]||0)>0 && retryAfter===statuses[429] && Object.keys(statuses).every(s=>s==='200'||s==='429'),scope:'Default 240 requests per minute protection; fixture HTTP requests consume the same IP budget; isolated database and Redis.'};
  await mkdir('test-results/comprehensive-summary',{recursive:true});await writeFile('test-results/comprehensive-summary/rate-limit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
} finally {if(backend)await backend.close();}
