/** Isolated HTTP/SSE profile; never opens the project's data directory. Node >=24. */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const self=fileURLToPath(import.meta.url),root=resolve(dirname(self),'..');
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]:0;

if(process.argv.includes('--worker')){
  let prepares=0;const original=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(...args){prepares++;return original.apply(this,args);};
  const {createClassroomServer}=await import(pathToFileURL(option('--server')));
  const app=createClassroomServer({dataDir:option('--data-dir'),teacherKey:'isolated-profile-only'});
  let stats={},cpu=process.cpuUsage(),start=performance.now();
  app.server.prependListener('request',(req,res)=>{
    const route=req.url.includes('/stream')?'SSE':req.url.split('?')[0].replace(/\/sessions\/[^/]+/,'/sessions/:id').replace(/\/drafts\/[^/]+/,'/drafts/:id');
    const entry=()=>stats[route]??={requests:0,bodyBytes:0,durations:[]};entry().requests++;
    const began=performance.now(),write=res.write.bind(res),end=res.end.bind(res);
    res.write=(chunk,...args)=>{if(chunk)entry().bodyBytes+=Buffer.byteLength(chunk);return write(chunk,...args);};
    res.end=(chunk,...args)=>{if(chunk)entry().bodyBytes+=Buffer.byteLength(chunk);return end(chunk,...args);};
    res.once('finish',()=>entry().durations.push(performance.now()-began));
  });
  app.server.listen(0,'127.0.0.1',()=>process.send({port:app.server.address().port}));
  process.on('message',async message=>{
    if(message==='reset'){stats={};prepares=0;cpu=process.cpuUsage();start=performance.now();process.send({reset:true});}
    if(message==='metrics'||message==='gc-metrics'){
      if(message==='gc-metrics')global.gc?.();
      const usage=process.cpuUsage(cpu),routes={};
      for(const [route,value] of Object.entries(stats))routes[route]={requests:value.requests,bodyBytes:value.bodyBytes,handlerP95Ms:percentile(value.durations,.95)};
      process.send({wallMs:performance.now()-start,cpuMs:(usage.user+usage.system)/1000,sqlitePrepareCalls:prepares,memory:process.memoryUsage(),processPeakRssMiB:process.resourceUsage().maxRSS/1024,routes});
    }
    if(message==='stop'){await app.shutdown();process.exit(0);}
  });
}else{
  const serverPath=resolve(option('--server',join(root,'server.mjs'))),historyRuns=Number(option('--history-runs','50'));
  if(!Number.isInteger(historyRuns)||historyRuns<0||historyRuns>100)throw new Error('--history-runs must be an integer from 0 to 100');
  const {exampleGraph,simulate}=await import(pathToFileURL(join(dirname(serverPath),'shared','engine.mjs')));
  const dir=mkdtempSync(join(tmpdir(),'supermarket-profile-'));
  const worker=fork(self,['--worker','--server',serverPath,'--data-dir',dir],{execArgv:process.argv.includes('--observe-gc')?['--expose-gc']:[],stdio:['ignore','ignore','inherit','ipc']});
  const agent=new Agent({keepAlive:true,maxSockets:64});
  let base,teacher,session,people=[],streams=[],autoAck=false,teacherRefresh=true,acks=[],refreshes=[],timer,events={studentState:0,teacherState:0,works:0};
  const output={node:process.version,platform:process.platform,serverPath,learners:60,historyRunsPerLearner:historyRuns,notes:'Server is a separate child process; RSS excludes the load client. Loopback results are not VPS capacity estimates.'};
  const rpc=async message=>{const reply=once(worker,'message');worker.send(message);return(await reply)[0];};
  async function api(path,method='GET',body,who=teacher){
    return new Promise((done,reject)=>{
      const began=performance.now(),req=request(base+path,{agent,method,headers:{cookie:who?.cookie||'','Content-Type':'application/json'}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{
          try{const text=Buffer.concat(chunks).toString();if(res.statusCode>=300)throw new Error(`HTTP ${res.statusCode}: ${text}`);
            done({...JSON.parse(text),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]||who?.cookie,latencyMs:performance.now()-began,bodyBytes:Buffer.byteLength(text)});
          }catch(error){reject(error);}
        });
      });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });
  }
  function openStream(who,isTeacher=false){return new Promise((done,reject)=>{
    const req=request(base+`/api/sessions/${session.id}/stream${isTeacher?'':'?role=student'}`,{headers:{cookie:who.cookie}},res=>{
      let buffer='',first=true;res.setEncoding('utf8');res.on('data',chunk=>{
        buffer+=chunk;let split;
        while((split=buffer.indexOf('\n\n'))>=0){
          const event=buffer.slice(0,split);buffer=buffer.slice(split+2);
          if(event.startsWith('event: state')){
            events[isTeacher?'teacherState':'studentState']++;
            if(autoAck&&!isTeacher){const data=JSON.parse(event.split('\ndata: ')[1]);const pending=api('/api/student/ack','POST',{version:data.session.version,chapterId:data.session.chapterId},who);pending.catch(()=>{});acks.push(pending);}
          }
          if(event.startsWith('event: works')){
            events.works++;
            if(teacherRefresh){clearTimeout(timer);timer=setTimeout(()=>{const pending=api(`/api/sessions/${session.id}/works?view=overview&since=${Date.now()-1000}`);pending.catch(()=>{});refreshes.push(pending);},250);}
          }
          if(first){first=false;done();}
        }
      });
    });req.on('error',reject);req.end();streams.push(req);
  });}
  async function settle(){let previous=-1;while(previous!==acks.length){previous=acks.length;await Promise.all(acks);await pause(30);}await pause(450);await Promise.all(refreshes);}
  async function begin(){await settle();acks=[];refreshes=[];events={studentState:0,teacherState:0,works:0};await rpc('reset');}
  async function finish(name,extra={}){await settle();const values=await Promise.all(acks);output[name]={...await rpc('metrics'),events:{...events},ackClientP95Ms:percentile(values.map(x=>x.latencyMs),.95),...extra};}
  try{
    const ready=await Promise.race([once(worker,'message'),once(worker,'exit').then(()=>{throw new Error('Profile server exited before listening');})]);base=`http://127.0.0.1:${ready[0].port}`;
    output.emptyServer=await rpc('metrics');
    teacher=await api('/api/teacher/login','POST',{key:'isolated-profile-only'});
    session=(await api('/api/sessions','POST',{name:'Isolated 60 learner profile'})).session;
    people=await Promise.all(Array.from({length:60},(_,i)=>api('/api/student/join','POST',{code:session.code,seat:String(i+1),name:'Profile '+(i+1)},{})));
    session=(await api(`/api/sessions/${session.id}/commands`,'POST',{commandId:'practice',action:'practice',expectedVersion:session.version})).session;
    await Promise.all([...people.map(person=>openStream(person)),openStream(teacher,true)]);autoAck=true;
    await begin();await pause(1100);await finish('connectedIdle');
    await begin();const graph=exampleGraph(1,'drink-swap','best');
    await Promise.all(people.map(person=>api('/api/student/drafts/'+person.learner.id+'-1','PUT',{graph,baseRevision:0,mutationId:'profile-save'},person)));
    await finish('sixtyConcurrentSaves');
    await begin();await Promise.all(people.map(person=>api(`/api/sessions/${session.id}/state`,'GET',undefined,person).then(state=>api('/api/student/ack','POST',{version:state.session.version,chapterId:state.session.chapterId},person))));
    await finish('sixtyExplicitHeartbeatAcks');
    await begin();session=(await api(`/api/sessions/${session.id}/commands`,'POST',{commandId:'pause',action:'pause',expectedVersion:session.version})).session;await finish('teacherPause');
    autoAck=false;teacherRefresh=false;for(const stream of streams)stream.destroy();streams=[];await pause(50);
    if(historyRuns){
      const db=new DatabaseSync(join(dir,'supermarket.sqlite'));
      try{
        const hasChangedAt=db.prepare('PRAGMA table_info(records)').all().some(column=>column.name==='changedAt');
        const insert=db.prepare(`INSERT OR REPLACE INTO records(kind,id,sessionId,learnerId,json${hasChangedAt?',changedAt':''}) VALUES(?,?,?,?,?${hasChangedAt?',?':''})`);
        const graph=exampleGraph(4,'delivery','best'),result=simulate(graph),createdAt=Date.now()-86400000;
        output.historySeed={runJsonBytes:0,runCount:60*historyRuns,draftVersionCount:60*historyRuns};
        db.exec('BEGIN');
        for(const person of people)for(let n=0;n<historyRuns;n++){
          const id=person.learner.id+'-history-'+n,common={id,sessionId:session.id,learnerId:person.learner.id,chapterId:4,taskId:'delivery',graph,createdAt:createdAt+n};
          const run=JSON.stringify({...common,status:'completed',valid:true,completed:true,trace:result.trace,result,metrics:result.metrics,revision:n+1});
          output.historySeed.runJsonBytes+=Buffer.byteLength(run);
          for(const [kind,json] of [['run',run],['draftVersion',JSON.stringify({...common,revision:n+1,updatedAt:createdAt+n})]])insert.run(kind,id,session.id,person.learner.id,json,...(hasChangedAt?[createdAt+n]:[]));
        }
        db.exec('COMMIT');
      }finally{db.close();}
      await begin();const summary=await api(`/api/sessions/${session.id}/works?view=overview`);await finish('historyOverview',{responseBytes:summary.bodyBytes,clientLatencyMs:summary.latencyMs,returnedRuns:summary.runs.length,isSummary:summary.summary===true});
      await begin();const delta=await api(`/api/sessions/${session.id}/works?view=overview&since=${summary.serverTime+1000}`);await finish('historyEmptyDelta',{responseBytes:delta.bodyBytes,clientLatencyMs:delta.latencyMs,returnedRuns:delta.runs.length});
    }
    if(process.argv.includes('--observe-gc'))output.afterForcedGc=await rpc('gc-metrics');
    if(option('--out'))writeFileSync(resolve(option('--out')),JSON.stringify(output,null,2)+'\n');
    console.log(JSON.stringify(output,null,2));
  }finally{
    autoAck=false;teacherRefresh=false;clearTimeout(timer);for(const stream of streams)stream.destroy();agent.destroy();
    if(worker.connected){const exited=once(worker,'exit');worker.send('stop');const timeout=setTimeout(()=>worker.kill('SIGKILL'),5000);await exited;clearTimeout(timeout);}
    rmSync(dir,{recursive:true,force:true});
  }
}
