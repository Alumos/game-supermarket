import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createClassroomServer } from '../server.mjs';
import { exampleGraph, simulate, buildGraph, DELIVERY_MAP } from '../shared/engine.mjs';

test('classroom permissions, commands, drafts, immutable runs, recovery, persistence and exports',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'supermarket-api-'));let app=createClassroomServer({dataDir:dir,teacherKey:'test-teacher'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');let base=`http://127.0.0.1:${app.server.address().port}`;
 const clients={teacher:'',student:'',other:''};
 async function call(path,{who='teacher',method='GET',body,status=200}={}){const r=await fetch(base+path,{method,headers:{Cookie:clients[who],...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))clients[who]=r.headers.get('set-cookie').split(';')[0];const type=r.headers.get('content-type')||'';const v=type.includes('application/json')?await r.json():await r.text();assert.equal(r.status,status,JSON.stringify(v));return v;}
 try{
  await call('/api/sessions',{who:'other',status:403});await call('/api/teacher/login',{method:'POST',body:{key:'wrong'},status:403});await call('/api/teacher/login',{method:'POST',body:{key:'test-teacher'}});
  let {session}=await call('/api/sessions',{method:'POST',body:{name:'五年2班'},status:201});const id=session.id;
  const first=await call('/api/student/join',{who:'student',method:'POST',body:{code:session.code,seat:'1',name:'小组一'}});let l=first.learner;assert.ok(['rice-roll','tea','plant','fish'].includes(l.taskId));
  await call('/api/student/join',{who:'other',method:'POST',body:{code:session.code,seat:'1',name:'伪装'},status:409});const second=await call('/api/student/join',{who:'other',method:'POST',body:{code:session.code,seat:'2',name:'小组二'}});assert.notEqual(second.learner.taskId,l.taskId);
  await call(`/api/learners/${l.id}/works`,{who:'other',status:403});await call(`/api/sessions/${id}/works`,{who:'student',status:403});
  const graph=exampleGraph(1,'drink-swap','best'),draftId=l.id+'-1';
  const save=(body,status=200)=>call(`/api/student/drafts/${draftId}`,{who:'student',method:'PUT',body,status});
  await save({graph,baseRevision:0,mutationId:'before'},409);
  const cmd={commandId:'start',expectedVersion:session.version,action:'practice'};session=(await call(`/api/sessions/${id}/commands`,{method:'POST',body:cmd})).session;assert.equal(session.phase,'practice');
  assert.equal((await call(`/api/sessions/${id}/commands`,{method:'POST',body:cmd})).session.version,session.version);
  await call(`/api/sessions/${id}/commands`,{method:'POST',body:{...cmd,commandId:'stale'},status:409});
  const saved=await save({graph,baseRevision:0,mutationId:'save1'});assert.equal(saved.draft.revision,1);assert.equal((await save({graph,baseRevision:0,mutationId:'save1'})).draft.revision,1);
  const conflict=await save({graph,baseRevision:0,mutationId:'conflict'},409);assert.equal(conflict.draft.revision,1);assert.ok(conflict.conflict.id);
  const result=simulate(graph),executedNodes=result.trace.map(t=>t.nodeId),payload={draftId,revision:1,graph,executedNodes,status:'completed'};
  const run=(await call('/api/student/runs',{who:'student',method:'POST',body:{...payload,runId:'good'}})).run;assert.equal(run.valid,true);assert.equal(run.timeUnit,undefined);assert.equal(run.result.timeUnit,undefined);
  const stop=(await call('/api/student/runs',{who:'student',method:'POST',body:{...payload,runId:'stop',status:'stopped',executedNodes:executedNodes.slice(0,2)}})).run;assert.equal(stop.valid,false);assert.equal(stop.metrics,null);assert.equal(stop.result.completed,false);assert.equal(stop.trace.length,2);
  const duplicate=(await call('/api/student/runs',{who:'student',method:'POST',body:{...payload,runId:'stop'}})).run;assert.equal(duplicate.status,'stopped');assert.equal(duplicate.valid,false);
  const forged=(await call('/api/student/runs',{who:'student',method:'POST',body:{...payload,runId:'short',executedNodes:[]}})).run;assert.equal(forged.valid,false);
  const altered=structuredClone(graph);altered.nodes[1].label='改后';await call('/api/student/runs',{who:'student',method:'POST',body:{...payload,graph:altered,runId:'altered'},status:409});
  await call('/api/student/submissions',{who:'student',method:'POST',body:{submissionId:'sub1',draftId,revision:1,runId:'good',explanation:'先腾出位置'}});
  session=(await call(`/api/sessions/${id}/commands`,{method:'POST',body:{commandId:'next',expectedVersion:session.version,action:'next'}})).session;assert.equal(session.chapterId,2);assert.equal(session.phase,'practice');
  const works=await call(`/api/sessions/${id}/works`);assert.equal(works.runs.length,3);assert.equal(works.submissions.length,2);assert.ok(works.submissions.some(s=>s.source==='chapter'));assert.equal(works.conflicts.length,1);const delta=await call(`/api/sessions/${id}/works?since=${Date.now()+1000}`);assert.equal(delta.incremental,true);assert.equal(delta.runs.length,0);assert.equal(delta.learners.length,2);
  await call('/api/student/ack',{who:'student',method:'POST',body:{version:session.version,chapterId:2}});const state=await call(`/api/sessions/${id}/state`);assert.equal(state.learners.find(x=>x.id===l.id).appliedVersion,session.version);
  const studentState=await call(`/api/sessions/${id}/state`,{who:'student'});assert.equal(studentState.learners,undefined);assert.equal(studentState.assignment.taskId,'fresh-juice');
  await call('/api/teacher/feedback',{method:'POST',body:{learnerId:l.id,chapterId:1,text:'做得好'}});assert.equal((await call('/api/student/works',{who:'student'})).feedback[0].text,'做得好');
  assert.match(await call(`/api/sessions/${id}/export?format=csv`),/小组一/);assert.match(await call(`/api/sessions/${id}/export?format=html`),/class="flow"/);const jsonExport=await call(`/api/sessions/${id}/export?format=json`);assert.equal(jsonExport.draftVersions.length,1);assert.deepEqual(jsonExport.timeUnits,{delivery:'minutes',otherTasks:'seconds'});assert.equal(jsonExport.runs.find(r=>r.id==='good').result.timeUnit,undefined);
  const shared=await call('/shared/engine.mjs');assert.match(shared,/export const CHAPTERS/);await call('/data/teacher-key.txt',{status:404});await call('/server.mjs',{status:404});
  const ctrl=new AbortController();const eventResponse=await fetch(base+`/api/sessions/${id}/stream`,{headers:{Cookie:clients.student},signal:ctrl.signal});const streamReader=eventResponse.body.getReader();const eventText=new TextDecoder().decode((await streamReader.read()).value);assert.match(eventText,/event: state/);const eventState=JSON.parse(eventText.split('data: ')[1].trim());assert.equal(eventState.learners,undefined);assert.equal(eventState.learner.id,l.id);ctrl.abort();
  const {recoveryCode}=await call('/api/teacher/recover',{method:'POST',body:{learnerId:l.id}});const oldCookie=clients.student;const recovered=await call('/api/student/recover',{who:'other',method:'POST',body:{code:session.code,recoveryCode}});assert.equal(recovered.learner.id,l.id);clients.student=oldCookie;await call('/api/student/works',{who:'student',status:403});await call('/api/student/recover',{who:'student',method:'POST',body:{code:session.code,recoveryCode},status:403});
  await new Promise(r=>app.server.close(r));app=createClassroomServer({dataDir:dir});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;assert.equal((await call(`/api/sessions/${id}/state`)).session.chapterId,2);assert.equal((await call(`/api/sessions/${id}/works`)).runs.length,3);
 }finally{await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});}
});

test('60 learners remain balanced across four jobs; delivery failures and scores remain authoritative',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'supermarket-load-')),app=createClassroomServer({dataDir:dir,teacherKey:'load-test'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 const send=async(path,method='GET',body,cookie='')=>{const r=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return {...data,cookie:r.headers.get('set-cookie')?.split(';')[0]||cookie};};
 try{const teacher=await send('/api/teacher/login','POST',{key:'load-test'});let {session}=await send('/api/sessions','POST',{name:'60端模拟'},teacher.cookie);const people=await Promise.all(Array.from({length:60},(_,i)=>send('/api/student/join','POST',{code:session.code,seat:String(i+1),name:'模拟组'+(i+1)})));const counts={};for(const p of people)counts[p.taskId]=(counts[p.taskId]||0)+1;assert.deepEqual(counts,{'rice-roll':15,tea:15,plant:15,fish:15});session=(await send(`/api/sessions/${session.id}/commands`,'POST',{commandId:'chapter4',expectedVersion:session.version,action:'chapter',chapterId:4},teacher.cookie)).session;session=(await send(`/api/sessions/${session.id}/commands`,'POST',{commandId:'practice4',expectedVersion:session.version,action:'practice'},teacher.cookie)).session;
  await Promise.all(people.map(p=>send('/api/student/ack','POST',{version:session.version,chapterId:4},p.cookie)));const state=await send(`/api/sessions/${session.id}/state`,'GET',undefined,teacher.cookie);assert.equal(state.learners.filter(l=>l.appliedVersion===session.version).length,60);
  const controllers=[];try{await Promise.all(people.map(async p=>{const ctrl=new AbortController();controllers.push(ctrl);const response=await fetch(base+`/api/sessions/${session.id}/stream`,{headers:{cookie:p.cookie},signal:ctrl.signal});const reader=response.body.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);const data=JSON.parse(chunk.split('data: ')[1].trim());assert.equal(data.learner.id,p.learner.id);assert.equal(data.learners,undefined);}));}finally{controllers.forEach(c=>c.abort());}
  const p=people[0];for(const [i,variant] of [[1,'cross'],[2,'best']]){
   const graph=exampleGraph(4,'delivery',variant),draftId=`${p.learner.id}-delivery`,result=simulate(graph);
   assert.equal(result.completed,true);await send(`/api/student/drafts/${draftId}`,'PUT',{graph,baseRevision:i-1,mutationId:'save'+i},p.cookie);
   const uploadTrace=structuredClone(result.trace);if(i===1){const removeUnit=value=>{if(value&&typeof value==='object'){delete value.timeUnit;for(const child of Object.values(value))removeUnit(child);}};removeUnit(uploadTrace);} // an offline run made before minute metadata must remain uploadable
   const body={runId:'delivery'+i,draftId,revision:i,graph,status:'completed',executedNodes:result.trace.map(t=>t.nodeId),trace:uploadTrace,metrics:{total:0,coins:999999,failed:0,delivered:6,onTime:true}};
   const run=(await send('/api/student/runs','POST',body,p.cookie)).run;
   assert.equal(run.valid,true);assert.equal(run.timeUnit,'minutes');assert.equal(run.result.timeUnit,'minutes');assert.equal(run.result.finalState.timeUnit,'minutes');assert.deepEqual(run.metrics,result.metrics);assert.notEqual(run.metrics.coins,999999);assert.equal(run.metrics.delivered+run.metrics.failed,6);assert.equal(run.metrics.failed,i===1?1:0);assert.equal(run.metrics.onTime,i===2);
   if(i===1){assert.ok(run.result.finalState.orders.some(o=>o.status==='spoiled'));const badTrace=structuredClone(result.trace);badTrace.find(t=>t.events.some(e=>e.type==='delivery')).events.find(e=>e.type==='delivery').coins=999999;const forged=(await send('/api/student/runs','POST',{...body,runId:'tampered-coins',trace:badTrace},p.cookie)).run;assert.equal(forged.valid,false);assert.equal(forged.metrics,null);}
  }
  const draftId=`${p.learner.id}-delivery`,graph=exampleGraph(4,'delivery','best');
  const long=structuredClone(graph);while(long.nodes.length<48){const end=long.nodes.find(n=>n.kind==='end'),edge=long.edges.find(e=>e.to===end.id),node={id:'extra-'+long.nodes.length,kind:'action',actionId:'move_to',params:{x:10,y:11}};edge.to=node.id;long.nodes.push(node);long.edges.push({from:node.id,to:end.id});}
  await send(`/api/student/drafts/${draftId}`,'PUT',{graph:long,baseRevision:2,mutationId:'long-48'},p.cookie);
  const over=structuredClone(long);over.nodes.push({id:'over',kind:'action',actionId:'move_to',params:{x:10,y:11}});const rejected=await fetch(base+`/api/student/drafts/${draftId}`,{method:'PUT',headers:{cookie:p.cookie,'content-type':'application/json'},body:JSON.stringify({graph:over,baseRevision:3,mutationId:'long-49'})});assert.equal(rejected.status,400);
  const csvResponse=await fetch(base+`/api/sessions/${session.id}/export?format=csv`,{headers:{cookie:teacher.cookie}});const csv=await csvResponse.text();assert.match(csv,/最佳金币/);assert.match(csv,/第四章首次分钟/);assert.match(csv,/第四章最佳收益方案分钟/);assert.doesNotMatch(csv,/第四章.*秒/);
  const printable=await fetch(base+`/api/sessions/${session.id}/export?format=html&chapterId=4`,{headers:{cookie:teacher.cookie}});const html=await printable.text();assert.match(html,/class="blocks"/);assert.match(html,/金币/);assert.match(html,/50分钟/);assert.match(html,/时限（分钟）/);assert.match(html,/到达时间（分钟）/);assert.doesNotMatch(html,/秒/);assert.doesNotMatch(html,/class="arrow"/);
  const own=await send('/api/student/works','GET',undefined,p.cookie);assert.equal(own.runs.length,3);assert.equal(own.runs[0].graph.revision,1);assert.equal(own.drafts[0].revision,3);assert.equal((await send(`/api/sessions/${session.id}/state`,'GET',undefined,p.cookie)).assignment.taskId,'delivery');
 }finally{await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});}
});


test('old offline delivery runs retain their scores and exports compare only the same rules',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'supermarket-rules-')),app=createClassroomServer({dataDir:dir,teacherKey:'rules-test'});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 async function send(path,method='GET',body,cookie=''){
  const response=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return {...data,cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie};
 }
 try{
  const teacher=await send('/api/teacher/login','POST',{key:'rules-test'});
  let {session}=await send('/api/sessions','POST',{name:'新旧配送规则'},teacher.cookie);
  const student=await send('/api/student/join','POST',{code:session.code,seat:'1',name:'规则兼容组'});
  for(const command of [{action:'chapter',chapterId:4},{action:'practice'}])session=(await send(`/api/sessions/${session.id}/commands`,'POST',{...command,commandId:command.action,expectedVersion:session.version},teacher.cookie)).session;
  const draftId=student.learner.id+'-delivery';
  const old=buildGraph(['H','B','A','D','E','F','C'].map(point=>({actionId:'move_to',params:{...DELIVERY_MAP.points[point]}})),{chapterId:4,taskId:'delivery'});delete old.deliveryRulesVersion;
  const graphs=[old,exampleGraph(4,'delivery','cross')];
  for(const [i,graph] of graphs.entries()){
   const result=simulate(graph),trace=structuredClone(result.trace);
   if(i===0){const strip=value=>{if(value&&typeof value==='object'){delete value.deliveryRulesVersion;for(const child of Object.values(value))strip(child);}};strip(trace);}
   await send(`/api/student/drafts/${draftId}`,'PUT',{graph,baseRevision:i,mutationId:'rules-'+i},student.cookie);
   const {run}=await send('/api/student/runs','POST',{runId:'rules-'+i,draftId,revision:i+1,graph,trace,executedNodes:result.trace.map(t=>t.nodeId),status:'completed',offline:i===0},student.cookie);
   assert.equal(run.valid,true);assert.equal(run.metrics.coins,i===0?115:83);assert.equal(run.metrics.total,i===0?44:49);
   if(i===0)assert.equal(run.graph.deliveryRulesVersion,undefined);
  }
  const exportPath=`/api/sessions/${session.id}/export?chapterId=4&format=`;
  const csv=await (await fetch(base+exportPath+'csv',{headers:{cookie:teacher.cookie}})).text();
  const row=csv.trim().split('\r\n').at(-1).slice(1,-1).split('","');
  assert.equal(row[7],'49');assert.equal(row[8],'49');assert.equal(row[9],'49');
  assert.deepEqual(row.slice(11,16),['83','83','83','5','1']);assert.equal(row[16],'A、E冷藏·慢行路段（当前）');
  const html=await (await fetch(base+exportPath+'html',{headers:{cookie:teacher.cookie}})).text();
  assert.match(html,/最佳方案：83金币，49分钟/);assert.doesNotMatch(html,/最佳方案：115金币/);
  const own=await send('/api/student/works','GET',undefined,student.cookie);
  assert.equal(own.runs[0].metrics.coins,115);assert.equal(own.runs[0].graph.deliveryRulesVersion,undefined);
 }finally{await app.shutdown();rmSync(dir,{recursive:true,force:true});}
});

test('explicit student context selects only the student cookie when both roles coexist',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'supermarket-roles-')),app=createClassroomServer({dataDir:dir,teacherKey:'roles-test'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 async function send(path,{cookie='',student=false,method='GET',body,status=200}={}){const r=await fetch(base+path,{method,headers:{cookie,...student?{'X-Supermarket-Role':'student'}:{},...body?{'Content-Type':'application/json'}:{}},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return {...data,cookie:r.headers.get('set-cookie')?.split(';')[0]||cookie};}
 try{const teacher=await send('/api/teacher/login',{method:'POST',body:{key:'roles-test'}}),{session}=await send('/api/sessions',{cookie:teacher.cookie,method:'POST',body:{name:'共享浏览器'},status:201});assert.equal((await send('/api/me',{cookie:teacher.cookie,student:true})).role,null);
 const joined=await send('/api/student/join',{cookie:teacher.cookie,student:true,method:'POST',body:{code:session.code,seat:'1',name:'同一浏览器学生'}}),both=teacher.cookie+'; '+joined.cookie;
 assert.equal((await send('/api/me',{cookie:both})).role,'teacher');const me=await send('/api/me',{cookie:both,student:true});assert.equal(me.role,'student');assert.equal(me.learner.id,joined.learner.id);assert.equal((await send('/api/student/works',{cookie:both,student:true})).learners[0].id,joined.learner.id);
 await send(`/api/sessions/${session.id}/works`,{cookie:both,student:true,status:403});await send('/api/sessions',{cookie:joined.cookie,status:403});await send('/api/sessions',{cookie:joined.cookie,student:true,status:403});assert.equal((await send('/api/sessions',{cookie:both})).sessions.length,1);
 const ctrl=new AbortController(),response=await fetch(base+`/api/sessions/${session.id}/stream?role=student`,{headers:{cookie:both},signal:ctrl.signal}),reader=response.body.getReader(),text=new TextDecoder().decode((await reader.read()).value),state=JSON.parse(text.split('data: ')[1].trim());assert.equal(state.learner.id,joined.learner.id);assert.equal(state.learners,undefined);ctrl.abort();
 const studentLogout=await fetch(base+'/api/logout',{method:'POST',headers:{cookie:both,'X-Supermarket-Role':'student'}});assert.match(studentLogout.headers.get('set-cookie'),/^sm_student=/);assert.doesNotMatch(studentLogout.headers.get('set-cookie'),/sm_teacher=/);assert.equal((await send('/api/me',{cookie:teacher.cookie})).role,'teacher');
 const teacherLogout=await fetch(base+'/api/logout',{method:'POST',headers:{cookie:both}});assert.match(teacherLogout.headers.get('set-cookie'),/^sm_teacher=/);assert.doesNotMatch(teacherLogout.headers.get('set-cookie'),/sm_student=/);assert.equal((await send('/api/me',{cookie:joined.cookie,student:true})).role,'student');
 const absentStudentLogout=await fetch(base+'/api/logout',{method:'POST',headers:{cookie:teacher.cookie,'X-Supermarket-Role':'student'}});assert.match(absentStudentLogout.headers.get('set-cookie'),/^sm_student=/);assert.doesNotMatch(absentStudentLogout.headers.get('set-cookie'),/sm_teacher=/);
 }finally{await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});}
});

async function autoJoinHarness(t,{teacherKey='auto-test',dir=mkdtempSync(join(tmpdir(),'supermarket-auto-'))}={}){
 let app,base;
 const start=async options=>{app=createClassroomServer({dataDir:dir,...options});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;};
 await start({teacherKey});
 t.after(async()=>{await app.shutdown();rmSync(dir,{recursive:true,force:true});});
 const call=async(path,{cookie='',headers={},method='GET',body,status=200}={})=>{const r=await fetch(base+path,{method,headers:{cookie,...headers,...body?{'content-type':'application/json'}:{}},body:body?JSON.stringify(body):undefined}),data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return {...data,cookie:r.headers.get('set-cookie')?.split(';')[0]||cookie};};
 return {call,get app(){return app;},dir,restart:async options=>{await app.shutdown();await start(options);}};
}

test('automatic joining is private, balanced, concurrent, durable and isolated between classrooms',async t=>{
 const h=await autoJoinHarness(t),{call}=h,token='private-browser-device-00000000000001';
 assert.deepEqual(await call('/api/student/current'),{session:null,cookie:''});
 assert.equal((await call('/api/student/auto-join',{method:'POST',body:{deviceToken:token}})).learner,null);
 await call('/api/student/auto-join',{method:'POST',body:{deviceToken:'A1'},status:400});
 const teacher=await call('/api/teacher/login',{method:'POST',body:{key:'auto-test'}});
 let {session}=await call('/api/sessions',{cookie:teacher.cookie,method:'POST',body:{name:'自动编号一课'},status:201});const firstId=session.id;
 const current=await call('/api/student/current');assert.deepEqual(Object.keys(current.session).sort(),['chapterId','id','name','phase','version']);assert.equal(current.session.id,firstId);
 const join=(deviceToken,cookie='')=>call('/api/student/auto-join',{method:'POST',cookie,body:{deviceToken}});
 const same=await Promise.all(Array.from({length:12},()=>join(token)));assert.equal(new Set(same.map(x=>x.learner.id)).size,1);
 const first=same[0];assert.equal(first.learner.autoCode,'A1');assert.equal(first.learner.seat,'A1');assert.equal(first.learner.name,'A1');assert.equal(first.session.phase,'waiting');assert.equal(first.assignment.taskId,'drink-swap');
 const people=await Promise.all(Array.from({length:59},(_,i)=>join(`private-browser-number-${String(i).padStart(12,'0')}`)));
 const all=[first,...people];assert.equal(new Set(all.map(x=>x.learner.autoCode)).size,60);assert.deepEqual(all.map(x=>Number(x.learner.autoCode.slice(1))).sort((a,b)=>a-b),Array.from({length:60},(_,i)=>i+1));
 const counts={};for(const p of all)counts[p.learner.taskId]=(counts[p.learner.taskId]||0)+1;assert.deepEqual(counts,{'rice-roll':15,tea:15,plant:15,fish:15});
 assert.equal((await join(token)).learner.id,first.learner.id);assert.equal((await join('another-device-token-0000000000000001',teacher.cookie+'; '+first.cookie)).learner.id,first.learner.id);
 assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM records WHERE json LIKE ?').get('%'+token+'%').n,0);
 const command=async(action,extra={})=>{session=(await call(`/api/sessions/${session.id}/commands`,{method:'POST',cookie:teacher.cookie,body:{action,commandId:`${action}-${session.version}`,expectedVersion:session.version,...extra}})).session;};
 await command('practice');const graph=exampleGraph(1,'drink-swap','best'),draftId=first.assignment.draftId;
 await call(`/api/student/drafts/${draftId}`,{cookie:first.cookie,method:'PUT',body:{graph,baseRevision:0,mutationId:'auto-save'}});
 const oldSession=session;
 ({session}=await call('/api/sessions',{cookie:teacher.cookie,method:'POST',body:{name:'自动编号二课'},status:201}));
 const secondId=session.id,newIdentity=await join(token,first.cookie);assert.equal(newIdentity.learner.autoCode,'A1');assert.notEqual(newIdentity.learner.id,first.learner.id);assert.equal(newIdentity.assignment.draftId.includes(newIdentity.learner.id),true);
 assert.equal((await call('/api/student/works',{cookie:newIdentity.cookie})).drafts.length,0);
 await call(`/api/student/drafts/${draftId}`,{cookie:newIdentity.cookie,method:'PUT',body:{graph,baseRevision:1,mutationId:'cross-class'},status:409});
 // Pausing an old classroom cannot silently steal the active classroom.
 const paused=(await call(`/api/sessions/${firstId}/commands`,{cookie:teacher.cookie,method:'POST',body:{action:'pause',commandId:'pause-old',expectedVersion:oldSession.version}})).session;
 assert.equal((await call('/api/sessions',{cookie:teacher.cookie})).currentSessionId,secondId);
 session=paused;await command('set-current');assert.equal((await call(`/api/sessions/${firstId}/state`,{cookie:teacher.cookie})).currentSessionId,firstId);
 const returned=await join(token,newIdentity.cookie);assert.equal(returned.learner.id,first.learner.id);assert.equal(returned.session.phase,'paused');assert.equal((await call('/api/student/works',{cookie:returned.cookie})).drafts[0].id,draftId);
 await h.restart();assert.equal((await call('/api/student/current')).session.id,firstId);assert.equal((await join(token)).learner.id,first.learner.id);
 await command('end');assert.equal((await call('/api/student/current')).session,null);assert.equal((await join(token)).learner,null);
 await h.restart();assert.equal((await call('/api/student/current')).session,null);
 // Ending and explicitly deleting the remaining classroom preserves the empty selection.
 session=(await call(`/api/sessions/${secondId}/state`,{cookie:teacher.cookie})).session;await command('set-current');await command('end');
 await call(`/api/sessions/${secondId}`,{cookie:teacher.cookie,method:'DELETE',body:{confirmName:session.name}});assert.equal((await call('/api/student/current')).session,null);
 await h.restart();assert.equal((await call('/api/student/current')).session,null);
});

test('recovering without classroom code transfers device access and keeps the original automatic number',async t=>{
 const {call}=await autoJoinHarness(t),teacher=await call('/api/teacher/login',{method:'POST',body:{key:'auto-test'}});
 const {session}=await call('/api/sessions',{cookie:teacher.cookie,method:'POST',body:{},status:201}),oldDevice='old-device-secret-00000000000000001',newDevice='new-device-secret-00000000000000001';
 const first=await call('/api/student/auto-join',{method:'POST',body:{deviceToken:oldDevice}});
 const {recoveryCode}=await call('/api/teacher/recover',{cookie:teacher.cookie,method:'POST',body:{learnerId:first.learner.id}});
 await call('/api/student/recover',{method:'POST',body:{code:'wrong',recoveryCode},status:403});
 const recovered=await call('/api/student/recover',{method:'POST',body:{recoveryCode,deviceToken:newDevice}});assert.equal(recovered.learner.id,first.learner.id);assert.equal(recovered.learner.autoCode,'A1');assert.equal(recovered.assignment.draftId,first.assignment.draftId);
 await call('/api/student/works',{cookie:first.cookie,status:403});
 assert.equal((await call('/api/student/auto-join',{method:'POST',body:{deviceToken:newDevice}})).learner.id,first.learner.id);
 const old=await call('/api/student/auto-join',{method:'POST',body:{deviceToken:oldDevice}});assert.notEqual(old.learner.id,first.learner.id);assert.equal(old.learner.autoCode,'A2');
 await call('/api/student/recover',{method:'POST',body:{code:session.code,recoveryCode},status:403});
});

test('current classroom migrates only once and environment password overrides persistent volumes and old cookies',async t=>{
 const original=process.env.SUPERMARKET_TEACHER_PASSWORD;delete process.env.SUPERMARKET_TEACHER_PASSWORD;
 t.after(()=>{if(original===undefined)delete process.env.SUPERMARKET_TEACHER_PASSWORD;else process.env.SUPERMARKET_TEACHER_PASSWORD=original;});
 const h=await autoJoinHarness(t,{teacherKey:'old-file-key'}),{call}=h;
 const old=await call('/api/teacher/login',{method:'POST',body:{key:'old-file-key'}});
 for(const [id,phase,createdAt] of [['old','practice',1],['latest','paused',2],['ended','ended',3]])h.app.db.prepare('INSERT INTO records(kind,id,json) VALUES(?,?,?)').run('session',id,JSON.stringify({id,name:id,chapterId:1,phase,createdAt,version:1}));
 h.app.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('settings','current-classroom');
 process.env.SUPERMARKET_TEACHER_PASSWORD='new-env-password';await h.restart({teacherKey:'lower-priority-option'});
 assert.equal(h.app.key,'new-env-password');assert.equal((await call('/api/student/current')).session.id,'latest');
 await call('/api/sessions',{cookie:old.cookie,status:403});
 for(const key of ['old-file-key','lower-priority-option'])await call('/api/teacher/login',{method:'POST',body:{key},status:403});
 const env=await call('/api/teacher/login',{method:'POST',body:{key:'new-env-password'}});
 assert.equal((await call('/api/sessions',{cookie:env.cookie})).currentSessionId,'latest');
 assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM records WHERE json LIKE ?').get('%new-env-password%').n,0);
 await h.restart();assert.equal((await call('/api/sessions',{cookie:env.cookie})).sessions.length,3);
 delete process.env.SUPERMARKET_TEACHER_PASSWORD;await h.restart({teacherKey:'explicit-option'});
 await call('/api/sessions',{cookie:env.cookie,status:403});await call('/api/teacher/login',{method:'POST',body:{key:'explicit-option'}});
 await h.restart();assert.equal(h.app.key,'old-file-key');await call('/api/teacher/login',{method:'POST',body:{key:'old-file-key'}});
 await call('/api/sessions',{cookie:old.cookie,status:403}); // Restoring an older password must not revive its revoked cookies.
});

test('an old tab cannot read or upload its queue with another classroom learner cookie',async t=>{
 const h=await autoJoinHarness(t),{call}=h,deviceToken='shared-tabs-browser-000000000000000001';
 const teacher=await call('/api/teacher/login',{method:'POST',body:{key:'auto-test'}});
 const create=async name=>{
  let {session}=await call('/api/sessions',{cookie:teacher.cookie,method:'POST',body:{name},status:201});
  session=(await call(`/api/sessions/${session.id}/commands`,{cookie:teacher.cookie,method:'POST',body:{action:'practice',commandId:'practice',expectedVersion:session.version}})).session;
  return session;
 };
 const oldSession=await create('旧标签页课堂'),old=await call('/api/student/auto-join',{method:'POST',body:{deviceToken}});
 const graph=exampleGraph(1,'drink-swap','best'),result=simulate(graph),draftId=old.assignment.draftId;
 const queued={graph,baseRevision:0,mutationId:'old-tab-first-upload'},original=structuredClone(queued);
 const nextSession=await create('新标签页课堂'),next=await call('/api/student/auto-join',{cookie:old.cookie,method:'POST',body:{deviceToken}});
 assert.notEqual(next.learner.id,old.learner.id);
 const before=h.app.db.prepare('SELECT kind,id,json FROM records ORDER BY kind,id').all();
 const oldHeaders={'X-Supermarket-Learner':old.learner.id};
 for(const [path,method,body] of [
  [`/api/student/drafts/${draftId}`,'PUT',queued],
  ['/api/student/works','GET'],
  ['/api/student/ack','POST',{version:nextSession.version,chapterId:1}],
  ['/api/student/runs','POST',{runId:'old-tab-run',draftId,revision:1,graph,status:'completed',executedNodes:result.trace.map(x=>x.nodeId)}],
  ['/api/student/submissions','POST',{submissionId:'old-tab-submission',draftId,revision:1}]
 ]){
  const denied=await call(path,{cookie:next.cookie,headers:oldHeaders,method,body,status:409});assert.equal(denied.identityMismatch,true);
 }
 await call('/api/student/works',{cookie:next.cookie,headers:{'X-Supermarket-Learner':''},status:409});
 assert.deepEqual(h.app.db.prepare('SELECT kind,id,json FROM records ORDER BY kind,id').all(),before);
 assert.deepEqual(queued,original);
 assert.equal((await call('/api/student/works',{cookie:next.cookie,headers:{'X-Supermarket-Learner':next.learner.id}})).drafts.length,0);
 // Rejoining the original classroom lets the still-pending transaction reach its original owner.
 await call(`/api/sessions/${oldSession.id}/commands`,{cookie:teacher.cookie,method:'POST',body:{action:'set-current',commandId:'return-old',expectedVersion:oldSession.version}});
 const returned=await call('/api/student/auto-join',{cookie:next.cookie,method:'POST',body:{deviceToken}});assert.equal(returned.learner.id,old.learner.id);
 const saved=await call(`/api/student/drafts/${draftId}`,{cookie:returned.cookie,headers:oldHeaders,method:'PUT',body:queued});assert.equal(saved.draft.learnerId,old.learner.id);assert.equal(saved.draft.sessionId,oldSession.id);
 assert.equal((await call('/api/student/works',{cookie:next.cookie,headers:{'X-Supermarket-Learner':next.learner.id}})).drafts.length,0);
});

test('third chapter tasks are freely selected, persist, and retain independent classroom works',async t=>{
 const h=await autoJoinHarness(t),{call}=h,deviceToken='task-choice-device-000000000000000001';
 const teacher=await call('/api/teacher/login',{method:'POST',body:{key:'auto-test'}});
 let {session}=await call('/api/sessions',{cookie:teacher.cookie,method:'POST',body:{name:'四区自主实践'},status:201});
 const first=await call('/api/student/auto-join',{method:'POST',body:{deviceToken}}),cookie=first.cookie,learnerId=first.learner.id;
 const headers={'X-Supermarket-Learner':learnerId};
 const student=(path,options={})=>call(path,{cookie,headers,...options});
 const choose=(taskId,options={})=>student('/api/student/task',{method:'POST',body:{taskId},...options});
 const command=async(action,chapterId)=>{session=(await call(`/api/sessions/${session.id}/commands`,{cookie:teacher.cookie,method:'POST',body:{action,chapterId,commandId:`${action}-${session.version}`,expectedVersion:session.version}})).session;};
 await choose('tea',{status:409});
 await command('chapter',3);assert.equal((await student(`/api/sessions/${session.id}/state`)).session.phase,'practice');await command('practice');
 let selected=first.learner.taskId,taskVersion=0;
 assert.equal(first.learner.taskVersion,0);assert.equal(first.assignment.taskVersion,0);
 for(const taskId of ['rice-roll','tea','plant','fish']){
  if(selected!==taskId)taskVersion++;
  const changed=await choose(taskId);selected=taskId;
  assert.equal(changed.learner.taskId,taskId);assert.equal(changed.assignment.taskId,taskId);
  assert.equal(changed.learner.taskVersion,taskVersion);assert.equal(changed.assignment.taskVersion,taskVersion);
  assert.equal((await choose(taskId)).assignment.taskVersion,taskVersion);
  const graph=exampleGraph(3,taskId,'best'),result=simulate(graph),draftId=changed.assignment.draftId;
  assert.equal(result.completed,true);
  const saved=await student(`/api/student/drafts/${draftId}`,{method:'PUT',body:{graph,baseRevision:0,mutationId:`save-${taskId}`}});
  assert.equal(saved.draft.revision,1);assert.equal(saved.draft.taskId,taskId);
  const {run}=await student('/api/student/runs',{method:'POST',body:{runId:`run-${taskId}`,draftId,revision:1,graph,status:'completed',executedNodes:result.trace.map(x=>x.nodeId)}});
  assert.equal(run.valid,true);assert.equal(run.taskId,taskId);
  await student('/api/student/submissions',{method:'POST',body:{submissionId:`submit-${taskId}`,draftId,revision:1,runId:run.id,explanation:`独立说明-${taskId}`}});
 }
 const refresh=await student(`/api/sessions/${session.id}/state`);assert.equal(refresh.assignment.taskId,'fish');assert.equal(refresh.assignment.taskVersion,taskVersion);
 const rejoined=await call('/api/student/auto-join',{cookie,method:'POST',body:{deviceToken}});assert.equal(rejoined.learner.id,learnerId);assert.equal(rejoined.assignment.taskId,'fish');assert.equal(rejoined.assignment.taskVersion,taskVersion);
 let works=await student('/api/student/works');
 for(const key of ['drafts','draftVersions','runs','submissions'])assert.deepEqual(works[key].map(x=>x.taskId).sort(),['fish','plant','rice-roll','tea']);
 const rice=works.drafts.find(d=>d.taskId==='rice-roll'),tea=works.drafts.find(d=>d.taskId==='tea');
 await student(`/api/student/drafts/${rice.id}`,{method:'PUT',body:{graph:tea.graph,baseRevision:1,mutationId:'cross-task-draft-id'},status:409});
 assert.equal((await student('/api/student/works')).drafts.find(d=>d.id===rice.id).taskId,'rice-roll');
 // A save authenticated before the task switch must not overwrite the later learner selection.
 const slowPayload=JSON.stringify({graph:tea.graph,baseRevision:1,mutationId:'overlapping-tea-save'}),requestStarted=once(h.app.server,'request');
 let slowRequest;
 const slowSave=new Promise((resolve,reject)=>{slowRequest=httpRequest({host:'127.0.0.1',port:h.app.server.address().port,path:`/api/student/drafts/${tea.id}`,method:'PUT',headers:{cookie,...headers,'content-type':'application/json'}},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('end',()=>{try{assert.equal(response.statusCode,200,body);resolve(JSON.parse(body));}catch(error){reject(error);}});});slowRequest.on('error',reject);slowRequest.write(slowPayload.slice(0,1));});
 t.after(()=>slowRequest.destroy());await requestStarted;
 taskVersion++;await choose('tea');slowRequest.end(slowPayload.slice(1));await slowSave;
 assert.equal((await student(`/api/sessions/${session.id}/state`)).assignment.taskId,'tea');
 assert.equal((await student(`/api/sessions/${session.id}/state`)).assignment.taskVersion,taskVersion);
 taskVersion++;await choose('fish');
 await choose('delivery',{status:400});await choose('unknown',{status:400});
 const mismatch=await choose('tea',{headers:{'X-Supermarket-Learner':'other-learner'},status:409});assert.equal(mismatch.identityMismatch,true);
 await command('pause');await choose('tea',{status:409});await choose('fish',{status:409});
 // A previously selected task can still upload its immutable work while another task is selected.
 const offlineGraph=structuredClone(rice.graph);offlineGraph.nodes[1].label='饭卷独立修改';
 const offline=await student(`/api/student/drafts/${rice.id}`,{method:'PUT',body:{graph:offlineGraph,baseRevision:1,mutationId:'offline-rice',offline:true}});assert.equal(offline.draft.revision,2);
 await student('/api/student/runs',{method:'POST',body:{runId:'offline-rice-run',draftId:rice.id,revision:2,graph:offlineGraph,status:'completed',executedNodes:simulate(offlineGraph).trace.map(x=>x.nodeId),offline:true}});
 await student('/api/student/submissions',{method:'POST',body:{submissionId:'offline-rice-sub',draftId:rice.id,revision:2,runId:'offline-rice-run',offline:true}});
 await command('resume');assert.equal((await student(`/api/sessions/${session.id}/state`)).assignment.taskId,'fish');
 await command('chapter',4);await command('practice');await choose('tea',{status:409});
 // Fixed tasks in other chapters remain strict, even when supplied graph steps are otherwise valid.
 await student(`/api/student/drafts/${learnerId}-invalid`,{method:'PUT',body:{graph:{...exampleGraph(3,'tea','best'),chapterId:4},baseRevision:0,mutationId:'wrong-chapter-task'},status:400});
 works=await call(`/api/sessions/${session.id}/works`,{cookie:teacher.cookie});
 assert.deepEqual([...new Set(works.submissions.filter(s=>s.source==='chapter').map(s=>s.taskId))].sort(),['fish','plant','rice-roll','tea']);
 const exportText=async format=>{const response=await fetch(`http://127.0.0.1:${h.app.server.address().port}/api/sessions/${session.id}/export?format=${format}`,{headers:{cookie:teacher.cookie}});assert.equal(response.status,200);return response.text();};
 const csv=await exportText('csv'),html=await exportText('html');
 for(const taskId of ['rice-roll','tea','plant','fish']){
  assert.ok(csv.split('\r\n').some(row=>row.includes(`"${taskId}","3","已完成","已提交"`)),`CSV has separate ${taskId} statistics`);
  assert.ok(html.includes(`实践区 · ${taskId}</h3>`));
  assert.equal(html.split(`独立说明-${taskId}`).length-1,1,`print includes ${taskId} explanation once`);
 }
 await h.restart({teacherKey:'auto-test'});
 const persisted=await call('/api/student/auto-join',{method:'POST',body:{deviceToken}});assert.equal(persisted.learner.id,learnerId);assert.equal(persisted.learner.taskId,'fish');assert.equal(persisted.learner.taskVersion,taskVersion);
 const retained=await call('/api/student/works',{cookie:persisted.cookie});assert.equal(retained.drafts.length,4);assert.equal(retained.runs.length,5);
});

test('learning goal self assessments are validated, task specific, durable and preserved across archives and exports',async t=>{
 const h=await autoJoinHarness(t),{call}=h;
 const teacher=await call('/api/teacher/login',{method:'POST',body:{key:'auto-test'}});
 let {session}=await call('/api/sessions',{cookie:teacher.cookie,method:'POST',body:{name:'学习目标自评'},status:201});
 const student=await call('/api/student/join',{method:'POST',body:{code:session.code,seat:'1',name:'自评小组'}}),learnerId=student.learner.id;
 const command=async(action,extra={})=>{session=(await call(`/api/sessions/${session.id}/commands`,{cookie:teacher.cookie,method:'POST',body:{action,commandId:`rating-${session.version}`,expectedVersion:session.version,...extra}})).session;};
 const post=async(body,status=200)=>call('/api/student/submissions',{cookie:student.cookie,method:'POST',body,status});
 const expected=[];
 for(const chapterId of [1,2,3,4]){
  if(chapterId!==1)await command('chapter',{chapterId});
  await command('practice');
  const tasks=chapterId===3?['rice-roll','tea','plant','fish']:[{1:'drink-swap',2:'fresh-juice',4:'delivery'}[chapterId]];
  for(const [index,taskId] of tasks.entries()){
   if(chapterId===3&&index>0)await command('chapter',{chapterId:3});
   if(chapterId===3)await call('/api/student/task',{cookie:student.cookie,method:'POST',body:{taskId}});
   const graph=exampleGraph(chapterId,taskId,'best'),draftId=`${learnerId}-${chapterId}-${taskId}`;
   await call(`/api/student/drafts/${draftId}`,{cookie:student.cookie,method:'PUT',body:{graph,baseRevision:0,mutationId:`save-${draftId}`}});
   const payload={draftId,revision:1,submissionId:`rated-${chapterId}-${taskId}`,offline:true},stars=chapterId===3?index%3+1:chapterId===4?1:4-chapterId;
   if(chapterId===1){
    for(const [i,selfAssessment] of [null,[],{},1,{goalId:2,stars:2},{goalId:'1',stars:2},{goalId:1,stars:0},{goalId:1,stars:4},{goalId:1,stars:1.5},{goalId:1,stars:'2'},{goalId:1,stars:true}].entries())await post({...payload,submissionId:`invalid-${i}`,selfAssessment},400);
    await post({...payload,submissionId:'earlier-rating',selfAssessment:{goalId:1,stars:1}});
   }
   const {submission}=await post({...payload,selfAssessment:{goalId:chapterId,stars,ignored:'not canonical'}});
   assert.deepEqual(submission.selfAssessment,{goalId:chapterId,stars});assert.equal(submission.source,'student');
   const duplicate=await post({...payload,selfAssessment:{goalId:chapterId,stars:stars===3?1:3}});
   assert.deepEqual(duplicate.submission,submission);
   await post({...payload,selfAssessment:{goalId:chapterId,stars:0}},400);
   expected.push({chapterId,taskId,stars,id:submission.id});
   // Old clients and offline queues remain readable without erasing the last rating.
   const legacy=await post({...payload,submissionId:`legacy-${chapterId}-${taskId}`,explanation:`旧版想法 ${taskId}`});
   assert.equal(legacy.submission.selfAssessment,undefined);
   const archive=await post({...payload,submissionId:`client-archive-${chapterId}-${taskId}`,source:'chapter',selfAssessment:{goalId:chapterId,stars:stars===3?1:3}});
   assert.equal(archive.submission.selfAssessment,undefined);assert.equal(archive.submission.source,'chapter');
  }
 }
 await command('end');
 const before=await call(`/api/sessions/${session.id}/works`,{cookie:teacher.cookie});
 assert.equal(before.submissions.filter(s=>s.selfAssessment).length,8); // seven task sections plus the earlier chapter-one rating
 assert.equal(before.submissions.some(s=>s.id.startsWith('invalid-')),false);
 const archives=before.submissions.filter(s=>s.source==='chapter');assert.ok(archives.some(s=>s.id.startsWith('archive-')));assert.ok(archives.every(s=>!Object.hasOwn(s,'selfAssessment')));
 await h.restart();
 const works=await call(`/api/sessions/${session.id}/works`,{cookie:teacher.cookie});
 assert.deepEqual(works.submissions,before.submissions);
 const json=await call(`/api/sessions/${session.id}/export?format=json`,{cookie:teacher.cookie});
 for(const entry of expected){const submission=json.submissions.find(s=>s.id===entry.id);assert.deepEqual(submission.selfAssessment,{goalId:entry.chapterId,stars:entry.stars});}
 const readExport=async format=>{
  const response=await fetch(`http://127.0.0.1:${h.app.server.address().port}/api/sessions/${session.id}/export?format=${format}`,{headers:{cookie:teacher.cookie}});
  assert.equal(response.status,200);return response.text();
 };
 const csv=await readExport('csv'),rows=csv.trim().split('\r\n').map(line=>line.replace(/^\uFEFF/,'').slice(1,-1).split('","'));
 assert.deepEqual(rows[0].slice(-3),['学习目标','最新自评星数','满分']);
 const goals={1:'了解顺序结构的特点',2:'学会将操作步骤转换成流程图',3:'学会用算法思维解决问题',4:'了解算法优化'};
 assert.equal(rows.length,8);
 for(const entry of expected){
  const row=rows.slice(1).find(r=>Number(r[3])===entry.chapterId&&(entry.chapterId!==3||r[2]===entry.taskId));
  assert.ok(row,entry.taskId);assert.deepEqual(row.slice(-3),[goals[entry.chapterId],String(entry.stars),'3']);
 }
 const html=await readExport('html');
 for(const entry of expected){
  const article=html.match(/<article>[\s\S]*?<\/article>/g).find(section=>section.includes(`第${entry.chapterId}章 ·`)&&section.includes(` · ${entry.taskId}</h3>`));
  assert.ok(article,entry.taskId);assert.ok(article.includes(`最新自评：${entry.stars} / 3星`));assert.ok(article.includes(goals[entry.chapterId]));assert.ok(article.includes(`旧版想法 ${entry.taskId}`));
 }
 assert.match(html,/自评记录：了解顺序结构的特点 · 1 \/ 3星/);
});
