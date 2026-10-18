// Real Chrome acceptance: zero-form entry, stable device identity, current-room changes.
// Only this process's temporary SQLite / credentials are used and removed on exit.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClassroomServer } from '../server.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dir=mkdtempSync(join(tmpdir(),'supermarket-auto-join-'));
const password='auto-classroom-password-42',previousPassword=process.env.SUPERMARKET_TEACHER_PASSWORD;
process.env.SUPERMARKET_TEACHER_PASSWORD=password;
let app;
try{app=createClassroomServer({dataDir:dir,teacherKey:'must-be-overridden-by-environment'});}finally{if(previousPassword===undefined)delete process.env.SUPERMARKET_TEACHER_PASSWORD;else process.env.SUPERMARKET_TEACHER_PASSWORD=previousPassword;}
const {server}=app,checks=[],errors=[];
let browser;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const teacherContext=await browser.newContext({viewport:{width:1440,height:1000}}),firstContext=await browser.newContext({viewport:{width:1180,height:820}}),secondContext=await browser.newContext({viewport:{width:1180,height:820}});
 const watch=page=>{page.on('pageerror',error=>errors.push(error.message));return page;};
 const teacher=watch(await teacherContext.newPage()),first=watch(await firstContext.newPage());
 async function api(context,path,{method='GET',body,status=200}={}){const response=await context.request.fetch(origin+path,{method,data:body});const data=await response.json();assert.equal(response.status(),status,JSON.stringify(data));return data;}
 async function poll(check,label,timeout=30000){const until=Date.now()+timeout;let last;while(Date.now()<until){last=await check();if(last)return last;await new Promise(resolve=>setTimeout(resolve,120));}throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);}
 async function joined(page,context,id,code){await poll(async()=>{const me=await api(context,'/api/me');return me.role==='student'&&me.learner.sessionId===id&&me;},'automatic student cookie for '+code);await poll(async()=>await page.locator('#accountButton').textContent().then(text=>text.trim()===code),'visible assigned '+code);assert.equal(await page.locator('#joinDialog').isVisible(),false);return (await api(context,'/api/me')).learner;}
 async function dragAction(page,action){const source=page.locator(`[data-action="${action}"]`),end=page.locator('#flowNodes .flow-node').last(),before=await page.locator('#flowNodes .flow-node').count();await source.scrollIntoViewIfNeeded();await end.scrollIntoViewIfNeeded();const a=await source.boundingBox(),b=await end.boundingBox();assert.ok(a&&b);await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:14});await page.mouse.up();await page.waitForFunction(count=>document.querySelectorAll('#flowNodes .flow-node').length===count,before+1);}
 async function screenshot(page,name){if(!process.env.SUPERMARKET_TEST_OUTPUT)return;const output=resolve(process.env.SUPERMARKET_TEST_OUTPUT);mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,name+'.png'),fullPage:true});}
 async function createRoom(name){await teacher.locator('#new-room').click();await teacher.locator('#class-name').fill(name);await teacher.locator('#create-form [type=submit],#create-form button.primary').first().click();await teacher.locator('#create-dialog').waitFor({state:'hidden'});if(await teacher.locator('#invite-dialog').isVisible()){assert.equal(await teacher.locator('#join-url').inputValue(),origin+'/');await teacher.locator('#invite-dialog [data-close]').click();}assert.match(await teacher.locator('#current-session-status').textContent(),/当前/);const {sessions}=await api(teacherContext,'/api/sessions');return sessions.find(session=>session.name===name);}
 const works=id=>api(teacherContext,`/api/sessions/${id}/works`);

 await first.goto(origin+'/');
 await poll(async()=>/等待|未开课/.test(await first.locator('#connection').textContent()),'no classroom waiting message');
 assert.equal((await api(firstContext,'/api/student/current')).session,null);assert.equal((await api(firstContext,'/api/me')).role,null);assert.equal(await first.locator('#joinDialog').isVisible(),false);
 if(await first.locator('#welcome').isVisible())await first.locator('#practiceButton').click();
 await poll(()=>first.locator('#runButton').isEnabled(),'free experience before class');await dragAction(first,'move_crate');assert.equal(await first.locator('#flowNodes .flow-node').count(),3);await screenshot(first,'auto-no-classroom');
 checks.push('root URL with no current class shows waiting status and allows free editing');

 await teacher.goto(origin+'/teacher.html');await teacher.locator('#key').fill('wrong-password');await teacher.locator('#login-form button').click();await poll(async()=>!!(await teacher.locator('#login-error').textContent()),'wrong teacher password rejected');assert.equal(await teacher.locator('#login-dialog').isVisible(),true);
 await teacher.locator('#key').fill(password);await teacher.locator('#login-form button').click();await teacher.locator('#login-dialog').waitFor({state:'hidden'});checks.push('teacher login form accepts configured environment password and rejects incorrect password');
 const room=await createRoom('自动入场验收 · 原课堂');assert.ok(room);
 const firstLearner=await joined(first,firstContext,room.id,'A1');assert.equal(first.url(),origin+'/');assert.equal(await first.locator('#runButton').isDisabled(),true);checks.push('already-open root page automatically enters a later-created class as A1');
 await teacher.locator('#practice').click();await poll(()=>first.locator('#runButton').isEnabled(),'practice enabled');
 await dragAction(first,'move_crate');await first.locator('#nodeLabel').fill('A1 原课堂草稿，刷新后保留');await first.locator('#nodeLabel').blur();
 const saved=await poll(async()=>{const data=await works(room.id);return data.drafts.find(d=>d.learnerId===firstLearner.id&&d.graph.nodes.some(n=>n.label==='A1 原课堂草稿，刷新后保留'));},'original class draft saved');
 await first.reload();const reloaded=await joined(first,firstContext,room.id,'A1');assert.equal(reloaded.id,firstLearner.id);await first.waitForFunction(()=>[...document.querySelectorAll('#flowNodes .flow-node')].some(node=>node.textContent.includes('A1 原课堂草稿')));assert.equal(await first.locator('#flowNodes .flow-node').count(),saved.graph.nodes.length);checks.push('refresh retains A1 learner identity and the saved draft');

 // A fresh second browser opens three root tabs concurrently. All must claim one device.
 const secondPages=await Promise.all(Array.from({length:3},async()=>watch(await secondContext.newPage())));
 await Promise.all(secondPages.map(page=>page.goto(origin+'/')));
 const secondLearners=await Promise.all(secondPages.map(page=>joined(page,secondContext,room.id,'A2')));assert.ok(secondLearners.every(learner=>learner.id===secondLearners[0].id));
 const originalWorks=await works(room.id);assert.equal(originalWorks.learners.length,2);assert.deepEqual(originalWorks.learners.map(l=>l.autoCode).sort(),['A1','A2']);await screenshot(first,'auto-student-a1');await screenshot(secondPages[0],'auto-student-a2');checks.push('two browser contexts receive A1/A2; concurrent tabs reuse A2 without adding learners');

 // Close other tabs so their edit leases cannot interfere with the restoration check.
 await Promise.all(secondPages.map(page=>page.close()));
 const nextRoom=await createRoom('自动入场验收 · 新课堂');
 const nextLearner=await joined(first,firstContext,nextRoom.id,'A1');assert.notEqual(nextLearner.id,firstLearner.id);await poll(async()=>await first.locator('#flowNodes .flow-node').count()===2,'new class starts its own draft');assert.equal(await first.locator('#runButton').isDisabled(),true);
 assert.deepEqual((await works(room.id)).drafts.find(d=>d.id===saved.id).graph,saved.graph);checks.push('changing current classroom automatically assigns the new room identity and retains old-room works');

 await teacher.locator(`[data-room="${room.id}"]`).click();await teacher.locator('#set-current').waitFor({state:'visible'});assert.equal((await api(firstContext,'/api/student/current')).session.id,nextRoom.id);assert.equal(await teacher.locator('#invite-btn').isDisabled(),true);await teacher.locator('#set-current').click();await poll(async()=>!await teacher.locator('#set-current').isVisible(),'teacher marks old room current');assert.match(await teacher.locator('#current-session-status').textContent(),/当前/);
 const restored=await joined(first,firstContext,room.id,'A1');assert.equal(restored.id,firstLearner.id);await first.waitForFunction(()=>[...document.querySelectorAll('#flowNodes .flow-node')].some(node=>node.textContent.includes('A1 原课堂草稿')));assert.equal(await first.locator('#flowNodes .flow-node').count(),saved.graph.nodes.length);assert.equal((await works(room.id)).learners.length,2);await teacher.locator('#search').fill('a1');await poll(async()=>await teacher.locator('#learners tr').count()===1,'teacher searches automatic student number');assert.match(await teacher.locator('#learners').textContent(),/学生 A1/);await screenshot(teacher,'auto-teacher-search-a1');await teacher.locator('#search').fill('');await screenshot(first,'auto-restored-original-class');checks.push('selecting the previous current classroom restores its original A1 and draft');
 // A new-room response may arrive before its works can be loaded. The old canvas
 // must never become editable or uploadable under the newly issued identity.
 let loadFailures=0;
 const failWorks=route=>{loadFailures++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'temporary classroom works unavailable'})});};
 await first.route('**/api/student/works',failWorks);
 const retryRoom=await createRoom('自动入场验收 · 载入失败恢复');await teacher.locator('#practice').click();
 await poll(()=>loadFailures>0,'new classroom works load deliberately fails');
 const retryLearner=await joined(first,firstContext,retryRoom.id,'A1');assert.notEqual(retryLearner.id,firstLearner.id);
 assert.equal(await first.locator('#runButton').isDisabled(),true);assert.equal(await first.locator('#flowNodes .flow-node').count(),2);assert.doesNotMatch(await first.locator('#flowNodes').textContent(),/A1 原课堂草稿/);
 let retryWorks=await works(retryRoom.id);assert.equal(retryWorks.drafts.some(draft=>draft.graph.nodes.some(node=>node.label==='A1 原课堂草稿，刷新后保留')),false);assert.equal(retryWorks.runs.length,0);await screenshot(first,'auto-load-failure-protected');
 await first.unroute('**/api/student/works',failWorks);
 await poll(()=>first.locator('#runButton').isEnabled(),'works load automatically retries and enables the new classroom');
 assert.equal(await first.locator('#flowNodes .flow-node').count(),2);assert.doesNotMatch(await first.locator('#flowNodes').textContent(),/A1 原课堂草稿/);
 await dragAction(first,'move_crate');await first.locator('#nodeLabel').fill('新课堂载入恢复后的独立草稿');await first.locator('#nodeLabel').blur();
 retryWorks=await poll(async()=>{const data=await works(retryRoom.id);return data.drafts.some(draft=>draft.graph.nodes.some(node=>node.label==='新课堂载入恢复后的独立草稿'))&&data;},'recovered classroom uploads only its own new draft');
 assert.equal(retryWorks.drafts.some(draft=>draft.graph.nodes.some(node=>node.label==='A1 原课堂草稿，刷新后保留')),false);await screenshot(first,'auto-load-failure-recovered');
 await teacher.locator(`[data-room="${room.id}"]`).click();await teacher.locator('#set-current').waitFor({state:'visible'});await teacher.locator('#set-current').click();
 const restoredAfterFailure=await joined(first,firstContext,room.id,'A1');assert.equal(restoredAfterFailure.id,firstLearner.id);await first.waitForFunction(()=>[...document.querySelectorAll('#flowNodes .flow-node')].some(node=>node.textContent.includes('A1 原课堂草稿')));assert.equal(await first.locator('#flowNodes .flow-node').count(),saved.graph.nodes.length);assert.equal((await works(room.id)).learners.length,2);
 checks.push('new-class works loading failure clears the old canvas, locks execution, retries automatically, and never uploads the old graph under the new identity');checks.push('returning after a failed class switch still restores the original learner and draft');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks,pageErrors:errors,learners:(await works(room.id)).learners.map(learner=>({id:learner.id,autoCode:learner.autoCode}))},null,2));
}finally{await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
