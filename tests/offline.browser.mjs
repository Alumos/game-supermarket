// Real offline DOM editing, execution and submission. All data is temporary.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassroomServer } from '../server.mjs';
let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dir=mkdtempSync(join(tmpdir(),'supermarket-offline-')),{server}=createClassroomServer({dataDir:dir,teacherKey:'offline-browser-test'});
let browser;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const teacherContext=await browser.newContext({viewport:{width:1440,height:1000}}),studentContext=await browser.newContext({viewport:{width:1180,height:820}});
 // Chromium can keep an already-open SSE socket alive through setOffline.
 // Track those sockets so the offline step also simulates the physical cable disconnect.
 await studentContext.addInitScript(()=>{const Native=window.EventSource;window.__offlineTestStreams=[];window.EventSource=class extends Native{constructor(...args){super(...args);window.__offlineTestStreams.push(this);}};});
 const teacher=await teacherContext.newPage(),student=await studentContext.newPage(),errors=[];
 for(const p of [teacher,student])p.on('pageerror',e=>{errors.push(e.message);console.error('pageerror:',e.message);});
 async function api(context,path,body){const r=await context.request.fetch(origin+path,{method:body?'POST':'GET',data:body});const data=await r.json();assert.ok(r.ok(),JSON.stringify(data));return data;}
 async function poll(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out: '+label);}
 async function dragAction(action){
  const source=student.locator(`[data-action="${action}"]`),end=student.locator('#flowNodes .flow-node').last(),before=await student.locator('#flowNodes .flow-node').count();
  await source.scrollIntoViewIfNeeded();await end.scrollIntoViewIfNeeded();
  const a=await source.boundingBox(),b=await end.boundingBox();assert.ok(a&&b,'palette and end node must be visible');
  await student.mouse.move(a.x+a.width/2,a.y+a.height/2);await student.mouse.down();
  await student.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:14});await student.mouse.up();
  await student.waitForFunction(count=>document.querySelectorAll('#flowNodes .flow-node').length===count,before+1);
 }
 await api(teacherContext,'/api/teacher/login',{key:'offline-browser-test'});let {session}=await api(teacherContext,'/api/sessions',{name:'离线切章补传验收'});
 await teacher.goto(origin+'/teacher.html');await teacher.locator('#room-title').filter({hasText:'离线切章'}).waitFor();
 await student.goto(origin+'/');await poll(async()=>await student.locator('#accountButton').textContent().then(t=>t.trim()==='A1'),'root URL automatically joins as A1');assert.equal(await student.locator('#joinDialog').isVisible(),false);
 const me=await api(studentContext,'/api/me'),learnerId=me.learner.id;
 await teacher.locator('#practice').click();await poll(()=>student.locator('#runButton').isEnabled(),'chapter 1 practice');
 // Save one known online draft first, so offline edits must become a new version.
 await dragAction('move_crate');
 await poll(async()=>{const d=await api(teacherContext,`/api/sessions/${session.id}/works`);return d.drafts.find(x=>x.learnerId===learnerId&&x.graph.nodes.length===3);},'initial saved graph');
 await studentContext.setOffline(true);await student.evaluate(()=>{for(const stream of window.__offlineTestStreams||[])stream.close();});await student.waitForTimeout(200);assert.match(await student.locator('#connection').textContent(),/离线/);
 // Another A->C is intentionally invalid: the first box was already moved.
 await dragAction('move_crate');await student.locator('#nodeLabel').fill('再搬一次，检查空柜');await student.locator('#nodeLabel').blur();
 await student.locator('#runButton').click();await poll(()=>student.locator('#stopButton').isEnabled(),'offline animation starts');
 // Teacher moves on while the disconnected device is still executing chapter 1.
 await teacher.locator('#next').click();session=(await api(teacherContext,`/api/sessions/${session.id}/state`)).session;assert.equal(session.chapterId,2);assert.equal(session.phase,'explain');assert.match(await student.locator('#sceneTitle').textContent(),/饮料/);
 try{await poll(async()=>await student.locator('#result').isVisible()&&await student.locator('#runButton').isEnabled(),'offline attempt finishes',45000);}catch(error){console.error(JSON.stringify({diagnostic:await student.evaluate(()=>({title:document.querySelector('#sceneTitle').textContent,result:document.querySelector('#result').textContent,resultHidden:document.querySelector('#result').hidden,runDisabled:document.querySelector('#runButton').disabled,stopDisabled:document.querySelector('#stopButton').disabled,notice:document.querySelector('#classNotice').textContent,connection:document.querySelector('#connection').textContent,dialogue:document.querySelector('#dialogueText').textContent,save:document.querySelector('#saveStatus').textContent})),errors},null,2));throw error;}assert.match(await student.locator('#result').textContent(),/停住|修改/);
 await student.locator('#submitButton').click();await student.locator('#selfRatingGroup label:has(input[name=selfStars][value="1"])').click();await student.locator('#submitForm [type=submit]').click();await student.locator('#submitDialog').waitFor({state:'hidden'});
 let before=await api(teacherContext,`/api/sessions/${session.id}/works`);assert.equal(before.runs.length,0);assert.equal(before.submissions.filter(s=>s.source==='student').length,0);assert.equal(before.drafts[0].graph.nodes.length,3);
 const ordering=[];
 student.on('response',r=>{const path=new URL(r.url()).pathname;if(path===`/api/sessions/${session.id}/state`||path.startsWith('/api/student/drafts/')||path==='/api/student/runs'||path==='/api/student/submissions')ordering.push({path,status:r.status()});});
 await studentContext.setOffline(false);await student.locator('#sceneTitle').filter({hasText:'水果'}).waitFor();assert.equal(await student.locator('#runButton').isDisabled(),true);assert.equal(await student.locator('#flowNodes .flow-node').count(),2);assert.equal((await api(studentContext,`/api/sessions/${session.id}/state`)).assignment.taskId,'fresh-juice');
 const after=await poll(async()=>{const d=await api(teacherContext,`/api/sessions/${session.id}/works`);return d.runs.length&&d.submissions.some(s=>s.source==='student')?d:null;},'offline queue uploads after chapter alignment',30000);
 assert.equal(after.runs.length,1);assert.equal(after.runs[0].chapterId,1);assert.equal(after.runs[0].status,'failed');assert.equal(after.runs[0].valid,false);assert.equal(after.runs[0].offline,true);assert.equal(after.runs[0].graph.nodes.length,4);
 const draft=after.drafts.find(d=>d.chapterId===1);assert.equal(draft.graph.nodes.length,4);assert.ok(draft.graph.nodes.some(n=>n.label==='再搬一次，检查空柜'));assert.equal(after.drafts.filter(d=>d.chapterId===2).length,0);
 const sub=after.submissions.find(s=>s.source==='student');assert.equal(sub.chapterId,1);assert.equal(sub.offline,true);assert.deepEqual(sub.selfAssessment,{goalId:1,stars:1});
 const stateIndex=ordering.findIndex(x=>x.path.endsWith('/state')&&x.status===200),firstWrite=ordering.findIndex(x=>x.path.startsWith('/api/student/drafts/')&&x.status===200);assert.ok(stateIndex>=0&&firstWrite>stateIndex,JSON.stringify(ordering));
 // Reload restores the target classroom; the old graph remains historical, not chapter 2.
 await student.reload();await student.locator('#sceneTitle').filter({hasText:'水果'}).waitFor();assert.equal(await student.locator('#flowNodes .flow-node').count(),2);assert.equal(await student.locator('#runButton').isDisabled(),true);const restored=await api(studentContext,'/api/me');assert.equal(restored.learner.id,learnerId);
 await api(teacherContext,'/api/teacher/feedback',{learnerId,chapterId:1,text:'你保留了离线尝试，下一次先检查来源柜有没有箱子。'});await student.locator('#historyButton').click();await student.locator('#historyDialog').waitFor({state:'visible'});assert.match(await student.locator('#historyList').textContent(),/下一次先检查来源柜/);assert.match(await student.locator('#historyList').textContent(),/需修改/);assert.deepEqual(errors,[]);
 // An upgrade must preserve obsolete transactions without blocking current work.
 await student.locator('#historyDialog .dialog-close').click();
 session=(await api(teacherContext,`/api/sessions/${session.id}/state`)).session;
 session=(await api(teacherContext,`/api/sessions/${session.id}/commands`,{commandId:'juice-after-upgrade',expectedVersion:session.version,action:'practice'})).session;
 await poll(()=>student.locator('#runButton').isEnabled(),'fruit station opened for migration check');
 await poll(()=>student.evaluate(async id=>(await (await import('/db.js')).get(`queue:${id}`,[])).length===0,learnerId),'earlier queue drained');
 const injected=await student.evaluate(async id=>{
  const db=await import('/db.js'),engine=await import('/shared/engine.mjs');
  const rice=engine.exampleGraph(3,'rice-roll'),riceResult=engine.simulate(rice),oldGraph={...rice,chapterId:2};
  const obsolete={id:'legacy-rice-queue',mutationId:'legacy-rice-mutation',kind:'submission',key:`draft:${id}:2:rice-roll`,graph:oldGraph,offline:true,createdAt:Date.now(),run:{id:'legacy-rice-run',runId:'legacy-rice-run',chapterId:2,taskId:'rice-roll',graph:oldGraph,status:'completed',valid:true,executedNodes:riceResult.trace.map(t=>t.nodeId),result:riceResult,metrics:riceResult.metrics},submission:{submissionId:'legacy-rice-submission',runId:'legacy-rice-run',source:'student',explanation:'升级前离线完成的饭卷，保留完整运行与想法。'}};
  const graph=engine.exampleGraph(2,'fresh-juice');graph.nodes.find(n=>n.kind==='action').label='升级后的鲜榨橙汁草稿';
  const current={id:'current-juice-queue',mutationId:'current-juice-mutation',kind:'draft',key:`draft:${id}:2:fresh-juice`,graph,offline:true,createdAt:Date.now()+1};
  await db.set(`queue:${id}`,[obsolete,current]);return {obsolete,current};
 },learnerId);
 await student.reload();await student.locator('#sceneTitle').filter({hasText:'水果'}).waitFor();
 const migrated=await poll(async()=>{const d=await api(teacherContext,`/api/sessions/${session.id}/works`);return d.drafts.find(x=>x.chapterId===2&&x.taskId==='fresh-juice'&&x.graph.nodes.some(n=>n.label==='升级后的鲜榨橙汁草稿'));},'current task syncs past obsolete queued transaction');
 assert.deepEqual({...migrated.graph,revision:0},{...injected.current.graph,revision:0});
 const preserved=await poll(()=>student.evaluate(async id=>{const db=await import('/db.js'),backup=await db.get(`backup:${id}:legacy-legacy-rice-queue`),queue=await db.get(`queue:${id}`,[]);return backup&&queue.length===0?backup:null;},learnerId),'obsolete transaction backed up and new queue drained');
 assert.deepEqual(preserved.graph,injected.obsolete.graph);assert.deepEqual(preserved.transaction,{...injected.obsolete,started:true});assert.match(preserved.reason,/旧版/);
 const migratedWorks=await api(teacherContext,`/api/sessions/${session.id}/works`);assert.equal(migratedWorks.drafts.some(x=>x.chapterId===2&&x.taskId==='rice-roll'),false);assert.equal(migratedWorks.runs.some(x=>x.id==='legacy-rice-run'),false);assert.equal(migratedWorks.submissions.some(x=>x.id==='legacy-rice-submission'),false);
 await student.locator('#historyButton').click();await student.locator('#historyDialog').waitFor({state:'visible'});await student.locator('[data-backup]').first().click();await student.locator('#historyBack').waitFor({state:'visible'});assert.match(await student.locator('#historyList').textContent(),/铺开海苔/);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:['offline DOM edit / animated failed attempt / chapter rating retained','teacher advanced while learner offline','reconnect fetches latest state before old-chapter uploads','old graph never written into the new chapter','refresh restores identity and explanation phase','fresh teacher feedback appears in student history','obsolete queued task preserves full graph / run / explanation backup','current fresh-juice draft syncs after obsolete queue head','legacy backup remains viewable in student history'],runs:after.runs.map(r=>({chapterId:r.chapterId,status:r.status,offline:r.offline,valid:r.valid})),pageErrors:errors},null,2));
}finally{await browser?.close();if(server.listening)await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
