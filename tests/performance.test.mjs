import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createClassroomServer} from '../server.mjs';
import {exampleGraph} from '../shared/engine.mjs';

// Measure actual emitted SSE and selected JSON rows rather than asserting a
// machine-dependent timing threshold. All databases and ports are temporary.
test('concurrent saves avoid peer broadcasts; acknowledgments and teacher work events coalesce',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'supermarket-performance-')),app=createClassroomServer({dataDir:dir,teacherKey:'performance'}),controllers=[];
 t.after(async()=>{controllers.forEach(c=>c.abort());await app.shutdown();rmSync(dir,{recursive:true,force:true});});
 let events={student:0,teacher:0,works:0};
 app.server.prependListener('request',(req,res)=>{if(!req.url.includes('/stream'))return;const write=res.write;res.write=function(chunk,...args){const text=String(chunk);if(text.startsWith('event: state'))events[req.headers.cookie.includes('sm_teacher')?'teacher':'student']++;if(text.startsWith('event: works'))events.works++;return write.call(this,chunk,...args);};});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 const api=async(path,method='GET',body,cookie='')=>{const r=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}),data=await r.json();assert.ok(r.ok,JSON.stringify(data));return {...data,cookie:r.headers.get('set-cookie')?.split(';')[0]||cookie};};
 const teacher=await api('/api/teacher/login','POST',{key:'performance'});let {session}=await api('/api/sessions','POST',{name:'并发测试'},teacher.cookie);
 const people=await Promise.all(Array.from({length:30},(_,i)=>api('/api/student/auto-join','POST',{deviceToken:`performance-student-device-${String(i).padStart(12,'0')}`})));
 session=(await api(`/api/sessions/${session.id}/commands`,'POST',{action:'practice',commandId:'start',expectedVersion:session.version},teacher.cookie)).session;
 for(const p of [teacher,...people]){const ctrl=new AbortController();controllers.push(ctrl);const r=await fetch(base+`/api/sessions/${session.id}/stream`,{headers:{cookie:p.cookie},signal:ctrl.signal});await r.body.getReader().read();}
 await new Promise(resolve=>setTimeout(resolve,120));events={student:0,teacher:0,works:0};
 const graph=exampleGraph(1,'drink-swap','best');
 await Promise.all(people.map(p=>api(`/api/student/drafts/${p.learner.id}-1`,'PUT',{graph,baseRevision:0,mutationId:'save'},p.cookie)));
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(events.student,0,'saving one learner must not trigger every peer to acknowledge again');assert.equal(events.teacher,0,'work saves do not need a complete roster');assert.ok(events.works>=1&&events.works<people.length/2,'teacher receives coalesced work invalidations');
 events={student:0,teacher:0,works:0};
 await Promise.all(people.map(p=>api('/api/student/ack','POST',{version:session.version,chapterId:1},p.cookie)));
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(events.student,0);assert.equal(events.works,0);assert.ok(events.teacher>=1&&events.teacher<people.length/2,'ack burst coalesces teacher rosters');
 const state=await api(`/api/sessions/${session.id}/state`,'GET',undefined,teacher.cookie);assert.equal(state.learners.filter(l=>l.appliedVersion===session.version).length,people.length);
 events={student:0,teacher:0,works:0};
 session=(await api(`/api/sessions/${session.id}/commands`,'POST',{action:'pause',commandId:'pause',expectedVersion:session.version},teacher.cookie)).session;
 assert.equal(events.student,people.length,'teacher commands still reach every student immediately');assert.equal(events.teacher,1);
 // Full exports still retain every learner's immutable graph version.
 const works=await api(`/api/sessions/${session.id}/works`,'GET',undefined,teacher.cookie);assert.equal(works.draftVersions.length,people.length);
});

test('legacy history migrates without changing JSON; incremental reads select only new rows and reuse prepared SQL',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'supermarket-history-')),filename=join(dir,'supermarket.sqlite');
 const legacy=new DatabaseSync(filename);legacy.exec('CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,sessionId TEXT,learnerId TEXT,json TEXT NOT NULL,PRIMARY KEY(kind,id))');
 const raw=[];const legacyPut=legacy.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
 legacy.exec('BEGIN');
 for(const [kind,row] of [['session',{id:'legacy-session',name:'旧课堂',phase:'ended',chapterId:4,version:8,createdAt:1}],['learner',{id:'legacy-learner',sessionId:'legacy-session',name:'旧学生',lastSeen:1,createdAt:1}]])legacyPut.run(kind,row.id,row.sessionId||null,null,JSON.stringify(row));
 for(let i=0;i<1000;i++){const row={id:'history-'+i,sessionId:'legacy-session',learnerId:'legacy-learner',updatedAt:i+1,graph:{nodes:[{id:'old',label:'旧作品 '+i+'x'.repeat(2000)}]}},json=JSON.stringify(row);raw.push(json);legacyPut.run('draftVersion',row.id,row.sessionId,row.learnerId,json);}
 const originalRuns=[0,1].map(i=>({id:'run-'+i,sessionId:'legacy-session',learnerId:'legacy-learner',chapterId:4,taskId:'delivery',createdAt:100+i,status:'completed',valid:i===1,completed:i===1,metrics:i===1?{total:45,coins:100}:null,revision:i+1,offline:i===0,reason:'保留运行说明',graph:{chapterId:4,taskId:'delivery',...(i?{deliveryRulesVersion:'cold-ae-slow-v3',deliveryCoordinates:'cartesian-bottom-left'}:{}),nodes:[{id:'original-node',payload:'x'.repeat(50000)}],edges:[]},result:{trace:[{data:'x'.repeat(50000)}]},trace:[{data:'x'.repeat(50000)}],executedNodes:['original-node']}));
 for(const row of originalRuns)legacyPut.run('run',row.id,row.sessionId,row.learnerId,JSON.stringify(row));
 const originalDraft={id:'draft',sessionId:'legacy-session',learnerId:'legacy-learner',chapterId:4,taskId:'delivery',updatedAt:200,revision:2,graph:originalRuns[1].graph};legacyPut.run('draft',originalDraft.id,originalDraft.sessionId,originalDraft.learnerId,JSON.stringify(originalDraft));
 const originalSubmission={id:'submission',sessionId:'legacy-session',learnerId:'legacy-learner',chapterId:4,taskId:'delivery',createdAt:201,source:'student',selfAssessment:{goalId:4,stars:3},explanation:'配送选择说明',revision:2,runId:'run-1',graph:originalRuns[1].graph};legacyPut.run('submission',originalSubmission.id,originalSubmission.sessionId,originalSubmission.learnerId,JSON.stringify(originalSubmission));
 legacy.exec('COMMIT');legacy.close();
 let prepared=0,selectedRows=0;const original=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){prepared++;const stmt=original.call(this,sql),all=stmt.all;stmt.all=function(...args){const rows=all.apply(this,args);if(sql.startsWith('SELECT json FROM records'))selectedRows+=rows.length;return rows;};return stmt;};
 const app=createClassroomServer({dataDir:dir,teacherKey:'history'});
 t.after(async()=>{await app.shutdown();DatabaseSync.prototype.prepare=original;rmSync(dir,{recursive:true,force:true});});
 assert.deepEqual(app.db.prepare('SELECT json FROM records WHERE kind=? ORDER BY rowid').all('draftVersion').map(x=>x.json),raw);
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 const login=await fetch(base+'/api/teacher/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:'history'})}),cookie=login.headers.get('set-cookie').split(';')[0];await login.json();
 const getWorks=async(since,view)=>{const params=new URLSearchParams();if(since)params.set('since',since);if(view)params.set('view',view);const r=await fetch(base+`/api/sessions/legacy-session/works?${params}`,{headers:{cookie}});assert.equal(r.status,200);return r.json();};
 const full=await getWorks();assert.equal(full.draftVersions.length,1000);assert.equal(full.incremental,false);
 assert.deepEqual(full.runs,originalRuns);
 const overview=await getWorks(0,'overview');assert.equal(overview.summary,true);assert.equal(overview.draftVersions.length,0);assert.equal(overview.conflicts.length,0);
 for(const [i,run] of overview.runs.entries()){const {graph,result,trace,executedNodes,...metadata}=originalRuns[i];assert.deepEqual(run,{...metadata,summary:true,graph:{chapterId:graph.chapterId,taskId:graph.taskId,...(i?{deliveryRulesVersion:graph.deliveryRulesVersion,deliveryCoordinates:graph.deliveryCoordinates}:{})}});}
 assert.equal(Object.hasOwn(overview.runs[0].graph,'deliveryRulesVersion'),false,'old rule versions must stay absent');
 const {graph:draftGraph,...draftSummary}=originalDraft,{graph:submissionGraph,...submissionSummary}=originalSubmission;
 assert.deepEqual(overview.drafts,[{...draftSummary,summary:true}]);assert.deepEqual(overview.submissions,[{...submissionSummary,summary:true}]);
 assert.ok(JSON.stringify(overview).length<JSON.stringify(full).length/100,'overview excludes graph/trace/version history before transmission');
 const deltaOverview=await getWorks(202,'overview');assert.equal(deltaOverview.runs.length,0);assert.equal(deltaOverview.drafts.length,0);assert.deepEqual(deltaOverview.submissions,[{...submissionSummary,summary:true}]);
 const detail=await (await fetch(base+'/api/learners/legacy-learner/works?history=0',{headers:{cookie}})).json();assert.deepEqual(detail.runs,originalRuns);assert.equal(detail.draftVersions.length,0);assert.deepEqual(detail.drafts,[originalDraft]);
 const exported=await (await fetch(base+'/api/sessions/legacy-session/export',{headers:{cookie}})).json();assert.deepEqual(exported.runs,originalRuns);assert.equal(exported.draftVersions.length,1000);
 const partial=await getWorks(1000);assert.deepEqual(partial.draftVersions.map(x=>x.id),['history-998','history-999']);
 selectedRows=0;const preparedBefore=prepared;
 for(let i=0;i<20;i++){const delta=await getWorks(Date.now());assert.equal(delta.draftVersions.length,0);assert.equal(delta.learners.length,1);}
 assert.equal(selectedRows,20,'unchanged history must not be read or parsed for a delta');assert.equal(prepared,preparedBefore,'repeated requests must not keep allocating native prepared statements');
 const plan=app.db.prepare('EXPLAIN QUERY PLAN SELECT json FROM records WHERE kind=? AND sessionId=? AND changedAt>=? ORDER BY rowid').all('draftVersion','legacy-session',1000);assert.ok(plan.some(row=>row.detail.includes('records_session_changed')));
 assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM records WHERE kind=?').get('draftVersion').n,1000,'optimization keeps every historical version');
});
