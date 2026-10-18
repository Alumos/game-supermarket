import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
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
  session=(await call(`/api/sessions/${id}/commands`,{method:'POST',body:{commandId:'next',expectedVersion:session.version,action:'next'}})).session;assert.equal(session.chapterId,2);assert.equal(session.phase,'explain');
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
  const printable=await fetch(base+`/api/sessions/${session.id}/export?format=html&chapterId=4`,{headers:{cookie:teacher.cookie}});const html=await printable.text();assert.match(html,/class="blocks"/);assert.match(html,/金币/);assert.match(html,/48分钟/);assert.match(html,/时限（分钟）/);assert.match(html,/到达时间（分钟）/);assert.doesNotMatch(html,/秒/);assert.doesNotMatch(html,/class="arrow"/);
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
   assert.equal(run.valid,true);assert.equal(run.metrics.coins,i===0?115:84);assert.equal(run.metrics.total,i===0?44:48);
   if(i===0)assert.equal(run.graph.deliveryRulesVersion,undefined);
  }
  const exportPath=`/api/sessions/${session.id}/export?chapterId=4&format=`;
  const csv=await (await fetch(base+exportPath+'csv',{headers:{cookie:teacher.cookie}})).text();
  const row=csv.trim().split('\r\n').at(-1).slice(1,-1).split('","');
  assert.equal(row[7],'48');assert.equal(row[8],'48');assert.equal(row[9],'48');
  assert.deepEqual(row.slice(11,16),['84','84','84','5','1']);assert.equal(row[16],'A、E冷藏（当前）');
  const html=await (await fetch(base+exportPath+'html',{headers:{cookie:teacher.cookie}})).text();
  assert.match(html,/最佳方案：84金币，48分钟/);assert.doesNotMatch(html,/最佳方案：115金币/);
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
