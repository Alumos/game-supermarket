// Real Chrome: safe classroom maintenance, tablet access and batched live updates.
// Uses an isolated SQLite directory and removes it, the browser and server on exit.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClassroomServer} from '../server.mjs';
import {exampleGraph,simulate} from '../shared/engine.mjs';
let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-teacher-maintenance-'));
const app=createClassroomServer({dataDir,teacherKey:'isolated-maintenance-test'}),{server}=app;
let browser;const checks=[],errors=[];
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const teacher=await browser.newContext({viewport:{width:1024,height:768}}),student=await browser.newContext();
 const page=await teacher.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const Native=EventSource;window.classroomStreams=[];window.EventSource=class extends Native{constructor(...args){super(...args);window.classroomStreams.push(this);}};});
 async function api(context,path,{method='GET',body,status=200}={}){const r=await context.request.fetch(origin+path,{method,data:body}),v=await r.json();assert.equal(r.status(),status,JSON.stringify(v));return v;}
 async function poll(check,label,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,80));}throw new Error('Timed out: '+label);}
 async function command(id,action){const {session}=await api(teacher,`/api/sessions/${id}/state`);return api(teacher,`/api/sessions/${id}/commands`,{method:'POST',body:{action,commandId:crypto.randomUUID(),expectedVersion:session.version}});}
 const rooms=async()=>(await api(teacher,'/api/sessions')).sessions;
 const create=async name=>(await api(teacher,'/api/sessions',{method:'POST',body:{name},status:201})).session;
 await api(teacher,'/api/teacher/login',{method:'POST',body:{key:'isolated-maintenance-test'}});
 const old=await create('已结束课堂「保留作品」');await command(old.id,'end');const current=await create('当前接入课堂');
 const joined=await api(student,'/api/student/join',{method:'POST',body:{code:current.code,seat:'1',name:'测试学生'}});
 await command(current.id,'practice');
 await page.goto(origin+'/teacher.html');await page.locator('#room-title').filter({hasText:current.name}).waitFor();
 await poll(()=>page.locator('#learners tr').count().then(n=>n===1),'live roster');
 let deleteRequests=0;page.on('request',r=>{if(r.method()==='DELETE')deleteRequests++;});
 for(const width of [1024,768]){await page.setViewportSize({width,height:768});for(const id of ['delete-room','clear-ended']){const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<768,`${id} visible on ${width}px tablet`);}}
 await page.locator('#delete-room').click();assert.match(await page.locator('#toast').textContent(),/先结束/);assert.equal(await page.locator('#maintenance-dialog').isVisible(),false);assert.equal(deleteRequests,0);
 await page.locator('#clear-ended').click();await page.locator('#maintenance-dialog').waitFor();assert.match(await page.locator('#maintenance-description').textContent(),/1 节已结束/);assert.equal(await page.locator('#maintenance-submit').isDisabled(),true);assert.equal(await page.locator('#maintenance-dialog [data-close]').evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Enter');await page.locator('#maintenance-dialog').waitFor({state:'hidden'});assert.equal(deleteRequests,0);assert.equal((await rooms()).length,2);
 checks.push('management controls visible on 1024/768 tablets; current classroom is protected; Enter defaults to cancel with no DELETE');
 // Repeated acknowledgments must leave unchanged DOM rows intact.
 const state=await api(teacher,`/api/sessions/${current.id}/state`),ack={version:state.session.version,receivedVersion:state.session.version,chapterId:1};
 await api(student,'/api/student/ack',{method:'POST',body:ack});await poll(()=>page.locator('#learners tr').textContent().then(t=>t.includes('已进入当前章')),'ack displayed');
 await page.evaluate(()=>{window.stableLearnerRow=document.querySelector('#learners tr');window.stableRoomButton=document.querySelector('#rooms .active');});
 await Promise.all(Array.from({length:20},()=>api(student,'/api/student/ack',{method:'POST',body:ack})));await page.waitForTimeout(500);
 assert.equal(await page.evaluate(()=>window.stableLearnerRow===document.querySelector('#learners tr')&&window.stableRoomButton===document.querySelector('#rooms .active')),true);
 // Slow real works responses while both visibility refresh and student saves arrive.
 let active=0,maxActive=0,workRequests=0;
 await page.route('**/api/sessions/*/works*',async route=>{active++;maxActive=Math.max(maxActive,active);workRequests++;try{await new Promise(r=>setTimeout(r,450));await route.continue();}finally{active--;}});
 const graph=exampleGraph(1),draftId=`${joined.learner.id}-1-drink-swap`;
 const save=async revision=>api(student,`/api/student/drafts/${draftId}`,{method:'PUT',body:{graph,baseRevision:revision,mutationId:crypto.randomUUID()}});
 const pendingVisibility=page.evaluate(()=>{for(let i=0;i<12;i++)document.dispatchEvent(new Event('visibilitychange'));});
 for(let i=0;i<12;i++)await save(i);await pendingVisibility;
 await poll(()=>page.locator('#learners tr').textContent().then(t=>t.includes('草稿 v12')),'latest draft visible');
 await page.unroute('**/api/sessions/*/works*');assert.equal(maxActive,1,'works fetches never overlap');assert.ok(workRequests<=3,`burst used ${workRequests} requests`);
 checks.push(`20 acknowledgments preserve learner/room DOM; 12 saves and 12 visibility events coalesce to ${workRequests} non-overlapping works requests with latest v12`);
 const overview=await api(teacher,`/api/sessions/${current.id}/works?view=overview`);assert.equal(overview.drafts[0].graph,undefined);assert.equal(overview.drafts[0].summary,true);
 let detailRequests=0;page.on('request',request=>{if(request.url().includes('/api/learners/')&&request.url().includes('/works'))detailRequests++;});
 await page.locator('[data-view]').click();await page.locator('.world-preview canvas').waitFor();assert.equal(await page.locator('.graph .flow-node').count(),5);await page.locator('#detail-dialog [data-close]').click();await poll(()=>page.locator('#detail-body').textContent().then(text=>text===''),'detail DOM released');
 await page.locator('[data-view]').click();await page.locator('.world-preview canvas').waitFor();assert.equal(detailRequests,2,'closing releases full details; reopening requests only the selected student again');
 await page.locator('.feedback-box textarea').fill('正在输入的教师反馈');await page.locator('[data-replay=start]').click();await page.evaluate(()=>window.activeReplayCanvas=document.querySelector('.world-preview canvas'));
 const otherStudent=await browser.newContext(),otherJoin=await api(otherStudent,'/api/student/join',{method:'POST',body:{code:current.code,seat:'2',name:'另一位学生'}});
 await api(otherStudent,`/api/student/drafts/${otherJoin.learner.id}-1-drink-swap`,{method:'PUT',body:{graph,baseRevision:0,mutationId:crypto.randomUUID()}});await page.waitForTimeout(800);assert.equal(detailRequests,2,'unrelated student saves do not fetch selected full history');
 await save(12);await poll(()=>Promise.resolve(detailRequests===3),'selected student detail refresh');await page.waitForTimeout(200);assert.equal(await page.locator('.feedback-box textarea').inputValue(),'正在输入的教师反馈');assert.equal(await page.evaluate(()=>window.activeReplayCanvas===document.querySelector('.world-preview canvas')),true,'background detail refresh preserves replay world');
 await page.locator('#detail-dialog [data-close]').click();
 checks.push('graph-free overview; selected-only full detail loads; unrelated saves do not refetch; selected updates preserve playback and feedback; close releases details');
 // Single deletion: cancel, wrong name, server conflict, success and selected stream reset.
 await page.locator(`[data-room="${old.id}"]`).click();await page.locator('#room-title').filter({hasText:old.name}).waitFor();
 await page.locator('#delete-room').click();assert.match(await page.locator('#maintenance-description').textContent(),/已结束课堂「保留作品」/);assert.match(await page.locator('.maintenance-warning').textContent(),/作品.*永久删除/);await page.locator('#maintenance-confirm').fill('wrong');assert.equal(await page.locator('#maintenance-submit').isDisabled(),true);await page.locator('#maintenance-dialog [data-close]').click();assert.equal(deleteRequests,0);
 await page.locator('#delete-room').click();await page.locator('#maintenance-confirm').fill(old.name);
 await page.route(`**/api/sessions/${old.id}`,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'先结束当前课堂'})}),{times:1});
 await page.locator('#maintenance-submit').click();await page.locator('#maintenance-error').filter({hasText:'先结束'}).waitFor();assert.equal(await page.locator('#room-title').textContent(),old.name);assert.equal((await rooms()).length,2);
 const deletion=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith('/'+old.id));await page.locator('#maintenance-submit').click();const response=await deletion;assert.deepEqual(response.request().postDataJSON(),{confirmName:old.name});await page.locator('#maintenance-dialog').waitFor({state:'hidden'});await page.locator('#room-title').filter({hasText:current.name}).waitFor();assert.equal((await rooms()).some(s=>s.id===old.id),false);
 assert.equal(await page.evaluate(id=>window.classroomStreams.filter(s=>s.url.includes(id)).every(s=>s.readyState===EventSource.CLOSED),old.id),true);assert.equal(await page.locator('#detail-dialog').isVisible(),false);checks.push('single deletion requires exact name; conflict preserves selected classroom; confirmed DELETE removes room and closes its stream');
 // Batch cleanup deletes only ended classrooms and leaves the current classroom and its works.
 const end1=await create('批量清理一');await command(end1.id,'end');const end2=await create('批量清理二');await command(end2.id,'end');await command(current.id,'set-current');
 await page.reload();await page.locator('#room-title').filter({hasText:current.name}).waitFor();await page.locator('#clear-ended').click();await page.locator('#maintenance-dialog').waitFor();assert.match(await page.locator('#maintenance-description').textContent(),/2 节已结束/);await page.locator('#maintenance-confirm').fill('清理已结束课堂');
 const batch=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith('/sessions/ended'));await page.locator('#maintenance-submit').click();const batchResponse=await batch;assert.deepEqual(batchResponse.request().postDataJSON(),{confirm:'清理已结束课堂'});assert.equal((await batchResponse.json()).deletedCount,2);await page.locator('#maintenance-dialog').waitFor({state:'hidden'});await poll(()=>page.locator('#rooms button').count().then(n=>n===1),'list updated');assert.deepEqual((await rooms()).map(s=>s.id),[current.id]);assert.equal((await api(teacher,`/api/sessions/${current.id}/works`)).drafts.find(d=>d.learnerId===joined.learner.id).revision,13);assert.equal(await page.locator('#clear-ended').isDisabled(),true);
 await command(current.id,'end');await poll(()=>page.locator('#phase-title').textContent().then(t=>t==='课堂已结束'),'end state');await page.locator('#delete-room').click();await page.locator('#maintenance-confirm').fill(current.name);await page.locator('#maintenance-submit').click();await page.locator('#maintenance-dialog').waitFor({state:'hidden'});await page.locator('#empty').waitFor();assert.equal(await page.locator('#dashboard').isVisible(),false);assert.equal(await page.locator('#delete-room').isDisabled(),true);assert.equal((await rooms()).length,0);assert.equal(await page.evaluate(()=>window.classroomStreams.every(s=>s.readyState===EventSource.CLOSED)),true);
 checks.push('batch removes only ended rooms and preserves current works; deleting final ended room clears dashboard, selection and all streams');
 // Delivery overview must keep rule-aware completion while full traces remain on demand.
 const deliveryRoom=await create('配送讲评按需读取');for(let i=0;i<3;i++)await command(deliveryRoom.id,'next');await command(deliveryRoom.id,'practice');
 const deliveryStudent=await browser.newContext(),deliveryJoin=await api(deliveryStudent,'/api/student/join',{method:'POST',body:{code:deliveryRoom.code,seat:'1',name:'配送学生'}}),deliveryGraph=exampleGraph(4,'delivery'),result=simulate(deliveryGraph),deliveryDraft=`${deliveryJoin.learner.id}-4-delivery`;
 await api(deliveryStudent,`/api/student/drafts/${deliveryDraft}`,{method:'PUT',body:{graph:deliveryGraph,baseRevision:0,mutationId:crypto.randomUUID()}});
 for(let i=0;i<2;i++)await api(deliveryStudent,'/api/student/runs',{method:'POST',body:{runId:crypto.randomUUID(),draftId:deliveryDraft,revision:1,graph:deliveryGraph,status:'completed',executedNodes:result.trace.map(step=>step.nodeId),trace:result.trace}});
 await page.reload();await page.locator('#room-title').filter({hasText:deliveryRoom.name}).waitFor();await poll(()=>page.locator('#stat-complete').textContent().then(text=>text==='1'),'rule-aware delivery completion');
 const deliveryOverview=await api(teacher,`/api/sessions/${deliveryRoom.id}/works?view=overview`);assert.equal(deliveryOverview.runs[0].summary,true);assert.equal(deliveryOverview.runs[0].graph.nodes,undefined);assert.equal(deliveryOverview.runs[0].trace,undefined);
 await page.locator('[data-view]').click();await page.locator('.world-preview canvas').waitFor();assert.equal(await page.locator('.program-block').count(),deliveryGraph.nodes.length);assert.equal(await page.locator('.delivery-orders tbody tr').count(),result.finalState.orders.length);assert.equal(await page.locator('.route-compare option').count(),1);assert.equal(await page.locator('.route-compare-body table tbody tr').count(),2);await page.locator('[data-replay=start]').click();await poll(()=>page.locator('.playback-status').textContent().then(text=>text.startsWith('第')),'delivery full trace replay');await page.locator('#detail-dialog [data-close]').click();
 checks.push('delivery summaries preserve rule-aware completion; selected full history renders all program blocks, orders, two-run route comparison and executable replay');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{await browser?.close();if(server.listening)await app.shutdown();if(app.db.isOpen)app.db.close();rmSync(dataDir,{recursive:true,force:true});}
