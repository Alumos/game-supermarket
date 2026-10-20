// Real classroom acceptance: task buttons, mouse/touch drags, map interaction,
// independent drafts, classroom gates and task-specific teacher inspection.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createClassroomServer} from '../server.mjs';
import {TASKS,actionLabel} from '../shared/engine.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
 try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Playwright is required.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-practice-choice-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-practice-choice'});
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
const tasks=TASKS.filter(task=>task.chapterId===3),checks=[],errors=[],saved=new Map();
let browser,student,teacher;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const teacherContext=await browser.newContext({viewport:{width:1440,height:1000}});
 const studentContext=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
 await studentContext.addInitScript(()=>{const Native=window.EventSource;window.__practiceChoiceStreams=[];window.EventSource=class extends Native{constructor(...args){super(...args);window.__practiceChoiceStreams.push(this);}};});
 teacher=await teacherContext.newPage();student=await studentContext.newPage();
 for(const [name,page] of [['teacher',teacher],['student',student]])page.on('pageerror',error=>errors.push(`${name}: ${error.message}`));
 const cdp=await studentContext.newCDPSession(student);
 async function api(context,path,{method='GET',body,status=200}={}){
  const response=await context.request.fetch(origin+path,{method,data:body}),data=await response.json();
  assert.equal(response.status(),status,JSON.stringify(data));return data;
 }
 async function poll(check,label,timeout=30000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){last=await check();if(last)return last;await new Promise(resolve=>setTimeout(resolve,120));}
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
 }
 const button=id=>student.locator(`[data-practice-task="${id}"]`);
 const graphNodes=()=>student.locator('#flowNodes .flow-node');
 const works=()=>api(teacherContext,`/api/sessions/${session.id}/works`);
 const current=()=>api(studentContext,`/api/sessions/${session.id}/state`);
 async function command(action,extra={}){
  const state=await api(teacherContext,`/api/sessions/${session.id}/state`);
  return api(teacherContext,`/api/sessions/${session.id}/commands`,{method:'POST',body:{commandId:crypto.randomUUID(),expectedVersion:state.session.version,action,...extra}});
 }
 async function chosen(id){
  await poll(()=>button(id).getAttribute('aria-pressed').then(value=>value==='true'),`${id} visibly selected`);
  await poll(async()=>(await current()).assignment.taskId===id,`${id} server selection`);
  await poll(()=>button(id).isEnabled(),`${id} finished loading`);
  assert.equal(await student.locator('#practiceTasks [aria-pressed=true]').count(),1);
  assert.deepEqual(await student.locator('#actionCards [data-action]').evaluateAll(elements=>elements.map(element=>element.dataset.action).sort()),tasks.find(task=>task.id===id).actions.map(action=>action.actionId).sort());
 }
 async function select(id,{touch=false}={}){
  const before=await current();
  if(touch)await button(id).tap();else await button(id).click();
  await chosen(id);const after=await current();
  assert.equal(after.learner.id,before.learner.id);
  assert.equal(after.learner.taskVersion,before.learner.taskVersion+(before.learner.taskId===id?0:1));
  assert.equal(after.assignment.taskVersion,after.learner.taskVersion);
 }
 async function dragAction(action,{touch=false}={}){
  await student.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));
  const source=student.locator(`[data-action="${action}"]`),end=graphNodes().last(),before=await graphNodes().count();
  await source.scrollIntoViewIfNeeded();await end.scrollIntoViewIfNeeded();
  const a=await source.boundingBox(),b=await end.boundingBox();assert.ok(a&&b,'operation and end node visible');
  const start={x:a.x+a.width/2,y:a.y+a.height/2},finish={x:b.x+b.width/2,y:b.y+b.height/2};
  if(touch){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
   for(let i=1;i<=14;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(finish.x-start.x)*i/14,y:start.y+(finish.y-start.y)*i/14,id:1}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else{
   await student.mouse.move(start.x,start.y);await student.mouse.down();await student.mouse.move(finish.x,finish.y,{steps:14});await student.mouse.up();
  }
  await student.waitForFunction(count=>document.querySelectorAll('#flowNodes .flow-node').length===count,before+1);
 }
 async function mapSelect(id){
  await student.locator('#world canvas').scrollIntoViewIfNeeded();
  const bounds=await student.locator('#world canvas').boundingBox(),x={ 'rice-roll':3,tea:8,plant:13,fish:18 }[id];
  // World uses a 640x480 source with independent landscape Y scaling.
  const sx=Math.min(bounds.width/640,bounds.height/480),sy=Math.min(bounds.height/480,sx*1.65);
  await student.mouse.click(bounds.x+(bounds.width-640*sx)/2+(32+x*28)*sx,bounds.y+(bounds.height-480*sy)/2+(24+9*28-15)*sy);
  await chosen(id);
 }
 async function assertRestored(id){
  await chosen(id);const expected=saved.get(id);
  await poll(()=>graphNodes().count().then(count=>count===expected.graph.nodes.length),`${id} graph restored`);
  assert.deepEqual(await student.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.map(element=>element.dataset.node)),expected.graph.nodes.map(node=>node.id));
  assert.deepEqual(await student.locator('#flowNodes .flow-node:not(.terminal) .node-copy strong').allTextContents(),expected.graph.nodes.filter(node=>node.kind==='action').map(actionLabel));
  assert.equal(await student.locator('#inspector').isVisible(),false,`${id} has no step inspector`);
 }
 await teacher.goto(origin+'/teacher.html');await teacher.locator('#key').fill('isolated-practice-choice');await teacher.locator('#login-form button').click();await teacher.locator('#login-dialog').waitFor({state:'hidden'});
 const {session}=await api(teacherContext,'/api/sessions',{method:'POST',body:{name:'第三章四任务选择验收'},status:201});
 await teacher.reload();await teacher.locator('#room-title').filter({hasText:'四任务选择'}).waitFor();
 await student.goto(origin+'/');await poll(()=>student.locator('#accountButton').textContent().then(text=>text.trim()==='A1'),'automatic A1 entry');
 const learnerId=(await current()).learner.id;
 assert.equal(await student.locator('#practiceTasks').isVisible(),false);
 const beforeDenied=await current();await api(studentContext,'/api/student/task',{method:'POST',body:{taskId:'tea'},status:409});
 assert.equal((await current()).learner.taskVersion,beforeDenied.learner.taskVersion);
 await command('chapter',{chapterId:3});await student.locator('#practiceTasks').waitFor();
 assert.equal(await student.locator('#practiceTasks [data-practice-task]').count(),4);
 await poll(()=>button('rice-roll').isEnabled(),'chapter 3 practice opens immediately');
 assert.equal(await student.locator('#practiceTasks button:enabled').count(),4);
 checks.push('task choices appear only in chapter 3 and teacher switching immediately opens all four choices');

 for(const task of tasks){
  await select(task.id,{touch:task.id==='fish'});
  assert.equal(await graphNodes().count(),2,`${task.id} begins with its own empty graph`);
  for(const action of task.actions){
   await dragAction(action.actionId,{touch:task.id==='fish'});
   assert.equal(await student.locator('#inspector').isVisible(),false,`${task.id} drag keeps the operation palette available`);
  }
  const visibleIds=await graphNodes().evaluateAll(elements=>elements.map(element=>element.dataset.node));
  const draft=await poll(async()=>{const data=await works();return data.drafts.find(d=>d.learnerId===learnerId&&d.taskId===task.id&&d.graph.nodes.length===7&&d.graph.nodes.every((node,index)=>node.id===visibleIds[index]));},`${task.id} independent SQLite draft`);
  assert.deepEqual(draft.graph.nodes.filter(node=>node.kind==='action').map(node=>node.actionId),task.actions.map(action=>action.actionId));
  for(const other of saved.values())assert.equal(draft.graph.nodes.filter(node=>node.kind==='action').some(node=>other.graph.nodes.some(existing=>existing.id===node.id)),false,'task action identities stay independent');
  saved.set(task.id,draft);
 }
 assert.equal(new Set([...saved.values()].map(draft=>draft.id)).size,4,'each task gets its own draft id');
 checks.push('all five operations of each of four tasks enter by real mouse/touch drags and save into four separate drafts');

 await mapSelect('tea');await assertRestored('tea');const staleTeaState=await current();
 await select('plant',{touch:true});await assertRestored('plant');
 await student.reload();await student.locator('#practiceTasks').waitFor();await assertRestored('plant');
 assert.equal((await current()).learner.id,learnerId);
 // Healthy SSE uses a real presence acknowledgement rather than polling the
 // complete room. Then close that stream to exercise the real GET fallback.
 let stateRequests=0;
 const observeState=request=>{if(new URL(request.url()).pathname===`/api/sessions/${session.id}/state`&&request.method()==='GET')stateRequests++;};
 student.on('request',observeState);
 const heartbeat=await student.waitForResponse(response=>new URL(response.url()).pathname==='/api/student/ack'&&response.request().method()==='POST'&&response.ok(),{timeout:15000});
 assert.equal((await heartbeat.json()).assignment.taskId,'plant');await assertRestored('plant');
 assert.equal(stateRequests,0,'a healthy stream uses presence acknowledgements without full-state polling');
 // A delayed fallback can carry the same classroom version but an older task
 // version. Deliver it through the actual fetch path after the newer selection.
 let staleDelivered=false;
 const staleRoute=async route=>{staleDelivered=true;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(staleTeaState)});};
 await student.route(`**/api/sessions/${session.id}/state`,staleRoute);
 await student.evaluate(()=>window.__practiceChoiceStreams.forEach(stream=>stream.close()));
 await poll(()=>staleDelivered,'older taskVersion delivered through disconnected-stream fallback',15000);
 await student.waitForTimeout(200);await assertRestored('plant');
 assert.equal((await student.evaluate(async()=>{const db=await import('/db.js');return db.get('participant');})).learner.taskId,'plant');
 await student.unroute(`**/api/sessions/${session.id}/state`,staleRoute);
 student.off('request',observeState);
 await student.reload();await student.locator('#practiceTasks').waitFor();await assertRestored('plant');
 for(const id of ['fish','rice-roll','tea','plant']){await select(id);await assertRestored(id);}
 checks.push('map click and touch choose tasks; returning, refreshing, presence acknowledgement and an older taskVersion from the disconnected-stream fallback preserve the selected task and exact graph identities');

 await student.locator('#runButton').click();await poll(()=>student.locator('#stopButton').isEnabled(),'plant animation starts');
 assert.equal(await student.locator('#practiceTasks button:enabled').count(),0,'running cannot switch tasks');
 await student.locator('#pauseButton').click();assert.equal(await student.locator('#practiceTasks button:enabled').count(),0,'student pause cannot switch tasks');
 await teacher.locator('#pause').click();await poll(()=>student.locator('#pauseButton').isDisabled(),'teacher pause overrides local pause');
 assert.equal(await student.locator('#practiceTasks button:enabled').count(),0);
 const paused=await current();await api(studentContext,'/api/student/task',{method:'POST',body:{taskId:'fish'},status:409});
 assert.equal((await current()).learner.taskVersion,paused.learner.taskVersion);
 await teacher.locator('#resume').click();await poll(()=>student.locator('#pauseButton').isEnabled(),'teacher resumes classroom');
 await student.locator('#pauseButton').click();
 const run=await poll(async()=>{const data=await works();return data.runs.find(run=>run.learnerId===learnerId&&run.taskId==='plant'&&run.valid);},'full plant execution saved',60000);
 assert.equal(run.graph.nodes.length,7);assert.equal(run.executedNodes.length,7);
 await poll(()=>button('tea').isEnabled(),'task choices reenable after execution');
 checks.push('running, student pause and teacher pause lock selection; resume completes a genuine valid plant run');

 await select('fish');await assertRestored('fish');
 await teacher.locator('[data-work-chapter="3"]').click();
 await poll(()=>teacher.locator('#learners').textContent().then(text=>text.includes('4/4')),'teacher sees four attempted tasks');
 await teacher.locator('#task-filter').selectOption('plant');await teacher.locator('#status-filter').selectOption('done');
 await poll(()=>teacher.locator('#learners [data-view]').count().then(count=>count===1),'completed plant remains discoverable after choosing fish');
 await teacher.locator('[data-view]').first().click();
 await poll(()=>teacher.locator('.detail-task').inputValue().then(value=>value==='plant'),'task filter opens plant details');
 for(const task of tasks){
  await teacher.locator('.detail-task').selectOption(task.id);await teacher.locator('.run-select').selectOption('draft');
  await poll(()=>teacher.locator('.work-detail').getAttribute('data-task').then(value=>value===task.id),`${task.id} teacher detail`);
  assert.deepEqual(await teacher.locator('.graph [data-node]').evaluateAll(elements=>elements.map(element=>element.dataset.node)),saved.get(task.id).graph.nodes.map(node=>node.id));
  assert.deepEqual(await teacher.locator('.graph [data-node] small').allTextContents(),saved.get(task.id).graph.nodes.filter(node=>node.kind==='action').map(node=>`实际操作：${actionLabel(node)}`));
  if(output)await teacher.screenshot({path:join(output,`practice-choice-detail-${task.id}.png`),fullPage:true});
 }
 await teacher.locator('#detail-dialog [data-close]').click();
 await teacher.locator('#task-filter').selectOption('tea');await poll(()=>teacher.locator('#learners [data-view]').count().then(count=>count===0),'plant completion is not counted as tea completion');
 await teacher.locator('#status-filter').selectOption('');await poll(()=>teacher.locator('#learners [data-view]').count().then(count=>count===1),'earlier tea draft remains discoverable while current fish');
 checks.push('teacher filters by task-specific completion, discovers historical tasks and inspects each independent graph');

 const selectedBeforeChapter=await current();await command('chapter',{chapterId:2});await student.locator('#sceneTitle').filter({hasText:'水果'}).waitFor();
 assert.equal(await student.locator('#practiceTasks').isVisible(),false);
 await poll(()=>student.locator('#actionCards [data-action]').first().isEnabled(),'chapter 2 operation cards open immediately');
 assert.equal(await student.locator('#submitButton').isEnabled(),true,'chapter 2 permits editing and self assessment before forming the flowchart');
 await api(studentContext,'/api/student/task',{method:'POST',body:{taskId:'tea'},status:409});
 assert.equal((await current()).learner.taskId,'fish');assert.equal((await current()).learner.taskVersion,selectedBeforeChapter.learner.taskVersion);
 await command('chapter',{chapterId:3});await student.locator('#practiceTasks').waitFor();await poll(()=>student.locator('#practiceTasks button:enabled').count().then(count=>count===4),'returning to chapter 3 immediately opens choices');
 await assertRestored('fish');
 const finalWorks=await works();
 for(const [id,draft] of saved){const final=finalWorks.drafts.find(item=>item.id===draft.id);assert.deepEqual(final.graph.nodes,draft.graph.nodes,`${id} retained after cross-chapter return`);}
 assert.equal(finalWorks.drafts.filter(draft=>draft.learnerId===learnerId&&draft.chapterId===3).length,4);
 checks.push('cross-chapter requests cannot change selection; returning to chapter 3 restores fish and keeps all four drafts');
 if(output){await student.locator('#transition').waitFor({state:'hidden'});await student.screenshot({path:join(output,'practice-choice-student.png')});await teacher.screenshot({path:join(output,'practice-choice-teacher.png'),fullPage:true});}
 await cdp.detach();assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks,pageErrors:errors,drafts:[...saved].map(([taskId,draft])=>({taskId,id:draft.id,nodes:draft.graph.nodes.length})),validRun:{taskId:run.taskId,status:run.status}},null,2));
}catch(error){
 if(output&&student)await student.screenshot({path:join(output,'practice-choice-failure.png')}).catch(()=>{});
 throw error;
}finally{
 await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});
}
