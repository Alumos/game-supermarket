// Real Chrome, separate teacher/student cookies, real editor clicks and animations.
// Runs an isolated server and removes all test SQLite / credential files on exit.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClassroomServer } from '../server.mjs';

const playwrightLocations=[process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean);
let playwright;
for(const location of playwrightLocations){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Playwright is required; set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dir=mkdtempSync(join(tmpdir(),'supermarket-browser-'));
const {server}=createClassroomServer({dataDir:dir,teacherKey:'isolated-browser-test'});
let browser;
const checks=[];
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const teacherContext=await browser.newContext({viewport:{width:1440,height:1000}}),studentContext=await browser.newContext({viewport:{width:1180,height:820}});
 const teacher=await teacherContext.newPage(),student=await studentContext.newPage(),errors=[];
 for(const p of [teacher,student])p.on('pageerror',e=>(errors.push(`${p===teacher?'teacher':'student'}: ${e.message}`),console.error('pageerror:',e.message)));
 async function json(context,path,{method='GET',body,status=200}={}){const r=await context.request.fetch(origin+path,{method,data:body});const d=await r.json();assert.equal(r.status(),status,JSON.stringify(d));return d;}
 async function poll(check,{timeout=30000,label='condition'}={}){const end=Date.now()+timeout;let value;while(Date.now()<end){value=await check();if(value)return value;await new Promise(r=>setTimeout(r,120));}throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(value)}`);}
 async function dragAction(action){
  const source=student.locator(`[data-action="${action}"]`),end=student.locator('#flowNodes .flow-node').last(),before=await student.locator('#flowNodes .flow-node').count();
  await source.scrollIntoViewIfNeeded();await end.scrollIntoViewIfNeeded();
  const a=await source.boundingBox(),b=await end.boundingBox();assert.ok(a&&b,'palette and end node must be visible');
  await student.mouse.move(a.x+a.width/2,a.y+a.height/2);await student.mouse.down();
  await student.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:14});await student.mouse.up();
  await student.waitForFunction(count=>document.querySelectorAll('#flowNodes .flow-node').length===count,before+1);
 }
 const works=()=>json(teacherContext,`/api/sessions/${session.id}/works`);
 // Authenticate through the actual teacher form, create the room with the authenticated API.
 await teacher.goto(origin+'/teacher.html');await teacher.locator('#key').fill('isolated-browser-test');await teacher.locator('#login-form button').click();await teacher.locator('#login-dialog').waitFor({state:'hidden'});
 let {session}=await json(teacherContext,'/api/sessions',{method:'POST',body:{name:'自动验收 · 完整课堂'},status:201});
 await teacher.reload();await teacher.locator('#room-title').filter({hasText:'自动验收'}).waitFor();
 await student.goto(origin+'/?code='+session.code);await student.locator('#joinDialog').waitFor({state:'visible'});await student.locator('#classCode').fill(session.code);await student.locator('[name=seat]').fill('1');await student.locator('[name=name]').fill('向日葵小组');await student.locator('#joinForm [type=submit]').click();await student.locator('#joinDialog').waitFor({state:'hidden'});
 await poll(async()=>{const d=await works();return d.learners.length===1&&d.learners[0].appliedVersion===session.version;},{label:'student chapter acknowledgement'});
 const me=await json(studentContext,'/api/me');assert.equal(me.role,'student');const learnerId=me.learner.id,assigned=me.learner.taskId;
 assert.equal(await student.locator('#runButton').isDisabled(),true);checks.push('student joins with a separate cookie; waiting room gates editing');
 // Permission isolation is checked using this real student context.
 await json(studentContext,`/api/sessions/${session.id}/works`,{status:403});
 await teacher.locator('#practice').click();await student.locator('#runButton').waitFor({state:'visible'});await poll(()=>student.locator('#runButton').isEnabled(),{label:'practice gate'});
 const beforeClick=await student.locator('#flowNodes .flow-node').count();await student.locator('[data-action=move_crate]').click();await student.waitForTimeout(120);assert.equal(await student.locator('#flowNodes .flow-node').count(),beforeClick);checks.push('clicking an operation card does not add a step');
 // Build the actual three-step swap by real mouse drags; no graph or DOM event injection.
 const moves=[['A','C'],['B','A'],['C','B']];
 for(const [from,to] of moves){await dragAction('move_crate');await student.locator('[data-param=from]').selectOption(from);await student.locator('[data-param=to]').selectOption(to);}
 assert.equal(await student.locator('#flowNodes .flow-node').count(),5);
 await poll(async()=>{const d=await works();return d.drafts.some(x=>x.learnerId===learnerId&&x.graph.nodes.length===5);},{label:'DOM graph reaches SQLite'});
 await student.locator('#runButton').click();await poll(()=>student.locator('#stopButton').isEnabled(),{label:'actual animated run starts'});
 await teacher.locator('#pause').click();await poll(()=>student.locator('#pauseButton').isDisabled(),{label:'teacher pause overrides student resume'});assert.equal(await student.locator('[data-action=move_crate]').isDisabled(),true);
 await teacher.locator('#resume').click();await poll(()=>student.locator('#pauseButton').isEnabled(),{label:'teacher resume'});
 const first=await poll(async()=>{const d=await works();return d.runs.find(r=>r.learnerId===learnerId&&r.valid);},{timeout:60000,label:'full real animation yields server validated completion'});
 assert.equal(first.status,'completed');assert.equal(first.graph.nodes.length,5);assert.equal(first.executedNodes.length,5);checks.push('actual DOM flow executes; teacher pause/resume; authoritative full run persists');
 // Submission is also sent through the actual student explanation dialog.
 await student.locator('#submitButton').click();await student.locator('#explanation').fill('我先借助空柜C腾出位置，再交换两箱饮料。');await student.locator('#submitForm [type=submit]').click();await student.locator('#submitDialog').waitFor({state:'hidden'});
 await poll(async()=>{const d=await works();return d.submissions.find(s=>s.source==='student'&&s.learnerId===learnerId);},{label:'student submission upload'});
 // The teacher receives the live work without reloading, then can inspect map and graph.
 await poll(async()=>await teacher.locator('#learners tr').first().textContent().then(t=>t.includes('已完成')&&t.includes('已主动提交')),{label:'live teacher works update'});
 await teacher.locator('[data-view]').first().click();await teacher.locator('.world-preview canvas').waitFor();assert.equal(await teacher.locator('.graph .flow-node').count(),5);await teacher.locator('#detail-dialog [data-close]').click();checks.push('submission and live teacher graph / execution view');
 // Starting another attempt and moving the classroom archives an interrupted prefix.
 await student.locator('#runButton').click();await poll(()=>student.locator('#stopButton').isEnabled(),{label:'second attempt'});await teacher.locator('#next').click();await student.locator('#sceneTitle').filter({hasText:'水果'}).waitFor();
 await poll(async()=>{const d=await works();return d.runs.find(r=>r.learnerId===learnerId&&r.status==='interrupted');},{label:'chapter interruption archival'});
 let d=await works();assert.equal(d.runs.filter(r=>r.valid).length,1);assert.ok(d.submissions.some(s=>s.source==='chapter'));assert.equal(await student.locator('#runButton').isDisabled(),true);checks.push('next chapter interrupts safely; no false success; previous works survive');
 // Chapter 2 is the fruit station; chapter 3 keeps the assigned job across refresh.
 const chapter2=await json(studentContext,`/api/sessions/${session.id}/state`);assert.equal(chapter2.assignment.taskId,'fresh-juice');
 await teacher.locator('#practice').click();await poll(()=>student.locator('#runButton').isEnabled(),{label:'chapter 2 practice'});await teacher.locator('#next').click();await student.locator('#sceneTitle').filter({hasText:'实践'}).waitFor();assert.equal(await student.locator('#localTask').isVisible(),false);
 const taskBefore=await json(studentContext,`/api/sessions/${session.id}/state`);assert.equal(taskBefore.assignment.taskId,assigned);await student.reload();await student.locator('#sceneTitle').filter({hasText:'实践'}).waitFor();const taskAfter=await json(studentContext,`/api/sessions/${session.id}/state`);assert.equal(taskAfter.assignment.taskId,assigned);assert.equal(taskAfter.learner.id,learnerId);checks.push('third chapter job and learner identity remain fixed after refresh');
 d=await works();assert.ok(d.drafts.find(x=>x.chapterId===1));assert.equal(d.runs.find(r=>r.id===first.id).graph.nodes.length,5);assert.deepEqual(errors,[]);
 if(process.env.SUPERMARKET_TEST_OUTPUT){const output=resolve(process.env.SUPERMARKET_TEST_OUTPUT);mkdirSync(output,{recursive:true});await teacher.screenshot({path:join(output,'teacher-classroom.png'),fullPage:true});await student.screenshot({path:join(output,'student-classroom.png')});}
 console.log(JSON.stringify({ok:true,checks,pageErrors:errors,learners:d.learners.length,drafts:d.drafts.length,runs:d.runs.map(r=>({status:r.status,valid:r.valid})),submissions:d.submissions.length},null,2));
}finally{await browser?.close();if(server.listening)await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
