// Focused HTTP/SSE regression in installed Chrome, including the missing
// AbortSignal.timeout feature found in Chromium 99. This is not Win7 hardware QA.
// Every run uses its own server/database and removes them, with no screenshots.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClassroomServer} from '../server.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
 try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
// Recreate only the original timeout strategy, so this remains runnable after
// the fix is committed without storing an old app fixture or a Git dependency.
const currentScript=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const timeoutImport="import {withRequestTimeout} from './request-timeout.mjs';";
assert.ok(currentScript.includes(timeoutImport),'app imports the request-timeout helper');
const legacyScript=currentScript.replace(timeoutImport,'const withRequestTimeout=request=>request(AbortSignal.timeout(10000));');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-communication-compat-'));
const password='isolated-communication-compat',previousPassword=process.env.SUPERMARKET_TEACHER_PASSWORD;
let app,browser;
const checks=[],errors=[];
try{
 process.env.SUPERMARKET_TEACHER_PASSWORD=password;
 try{app=createClassroomServer({dataDir});}finally{if(previousPassword===undefined)delete process.env.SUPERMARKET_TEACHER_PASSWORD;else process.env.SUPERMARKET_TEACHER_PASSWORD=previousPassword;}
 const {server}=app;
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 async function api(context,path,{method='GET',body,status=200}={}){
  const response=await context.request.fetch(origin+path,{method,data:body}),data=await response.json();
  assert.equal(response.status(),status,JSON.stringify(data));return data;
 }
 async function poll(check,label,timeout=25000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){last=await check();if(last)return last;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
 }
 async function context(missingTimeout){
  const result=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await result.addInitScript(missing=>{
   if(missing)delete AbortSignal.timeout;
   window.__communicationStreams=[];window.__communicationStates=[];
   const Native=window.EventSource;
   window.EventSource=class extends Native{constructor(...args){super(...args);window.__communicationStreams.push(this);this.addEventListener('state',event=>window.__communicationStates.push(JSON.parse(event.data).session));}};
  },missingTimeout);
  return result;
 }
 function watch(page,label){page.on('pageerror',error=>errors.push(`${label}: ${error.message}`));return page;}
 async function joined(page,client,sessionId,code){
  await poll(()=>page.locator('#accountButton').textContent().then(text=>text.trim()===code),`visible ${code}`);
  const me=await api(client,'/api/me');assert.equal(me.role,'student');assert.equal(me.learner.sessionId,sessionId);
  assert.equal(me.learner.autoCode,code);assert.equal(await page.locator('#joinDialog').isVisible(),false);return me.learner;
 }
 const setup=await context(false);
 await api(setup,'/api/teacher/login',{method:'POST',body:{key:password}});
 const {session:oldRoom}=await api(setup,'/api/sessions',{method:'POST',body:{name:'旧脚本复现'},status:201});
 await api(setup,`/api/sessions/${oldRoom.id}/commands`,{method:'POST',body:{action:'practice',commandId:crypto.randomUUID(),expectedVersion:oldRoom.version}});
 const legacyContext=await context(true),legacy=watch(await legacyContext.newPage(),'legacy');
 let legacyLoads=0;const legacyRequests=[];
 await legacy.route('**/app.js',route=>{legacyLoads++;return route.fulfill({status:200,contentType:'text/javascript',body:legacyScript});});
 legacy.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))legacyRequests.push(new URL(request.url()).pathname);});
 await legacy.goto(origin+'/');await legacy.locator('#welcome').waitFor();
 assert.equal(await legacy.evaluate(()=>typeof AbortSignal.timeout),'undefined');
 await legacy.locator('#joinOpenButton').click();await legacy.locator('#accountButton').click();
 // Include one complete 4-second classroom-discovery polling period.
 await legacy.waitForTimeout(4300);
 assert.equal(legacyLoads,1);assert.equal((await api(legacyContext,'/api/student/current')).session.id,oldRoom.id);
 assert.equal((await api(legacyContext,'/api/me')).role,null);
 assert.equal(legacyRequests.filter(path=>path==='/api/student/auto-join').length,0);
 assert.deepEqual(legacyRequests,[],'the missing method fails before fetch is called');
 assert.notEqual((await legacy.locator('#accountButton').textContent()).trim(),'A1');
 checks.push({environment:'recreated original timeout strategy + missing AbortSignal.timeout',joined:false,autoJoinRequests:0,browserApiRequests:0});
 console.log('Reproduced original timeout strategy: active classroom cannot join; browser /api/student/auto-join requests = 0.');
 await legacyContext.close();await setup.close();

 for(const missingTimeout of [false,true]){
  const environment=missingTimeout?'missing AbortSignal.timeout':'native AbortSignal.timeout';
  const teacherContext=await context(missingTimeout),firstContext=await context(missingTimeout),secondContext=await context(missingTimeout);
  const teacher=watch(await teacherContext.newPage(),environment+' teacher'),first=watch(await firstContext.newPage(),environment+' A1'),second=watch(await secondContext.newPage(),environment+' A2');
  // Exercise both GET identity lookup and POST login in app.js teacherRequest().
  await teacher.goto(origin+'/?mode=demo');await teacher.locator('#teacherDemoDialog').waitFor();
  assert.equal(await teacher.evaluate(()=>typeof AbortSignal.timeout),missingTimeout?'undefined':'function');
  await teacher.locator('#teacherDemoPassword').fill(password);await teacher.locator('#teacherDemoForm [type=submit]').click();
  await poll(()=>teacher.locator('body').evaluate(body=>body.classList.contains('teacher-demo-mode')),environment+' teacher authentication');
  await teacher.goto(origin+'/teacher.html');await teacher.locator('#new-room').click();
  const name='通信兼容 · '+environment;await teacher.locator('#class-name').fill(name);await teacher.locator('#create-form button.primary').click();
  await teacher.locator('#create-dialog').waitFor({state:'hidden'});
  if(await teacher.locator('#invite-dialog').isVisible())await teacher.locator('#invite-dialog [data-close]').click();
  const room=(await api(teacherContext,'/api/sessions')).sessions.find(session=>session.name===name);assert.ok(room);
  const works=()=>api(teacherContext,`/api/sessions/${room.id}/works`);
  const autoJoinRequests=[0,0];
  for(const [index,page] of [first,second].entries())page.on('request',request=>{if(new URL(request.url()).pathname==='/api/student/auto-join')autoJoinRequests[index]++;});
  await first.goto(origin+'/');const learner=await joined(first,firstContext,room.id,'A1');
  await second.goto(origin+'/');const secondLearner=await joined(second,secondContext,room.id,'A2');
  assert.ok(autoJoinRequests.every(count=>count>0),'both learners join over HTTP');
  await first.reload();assert.equal((await joined(first,firstContext,room.id,'A1')).id,learner.id);
  assert.deepEqual((await works()).learners.map(l=>l.autoCode).sort(),['A1','A2']);
  await teacher.locator('#practice').click();await poll(()=>first.locator('#runButton').isEnabled(),environment+' editing enabled');
  // Use the visible operation card and a real pointer drag, then verify server data.
  await first.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));
  const source=first.locator('[data-action="move_crate"]'),target=first.locator('#flowNodes .flow-node').last();
  await source.scrollIntoViewIfNeeded();await target.scrollIntoViewIfNeeded();
  const a=await source.boundingBox(),b=await target.boundingBox();assert.ok(a&&b);
  await first.mouse.move(a.x+a.width/2,a.y+a.height/2);await first.mouse.down();
  await first.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:14});await first.mouse.up();
  await first.waitForFunction(()=>document.querySelectorAll('#flowNodes .flow-node').length===3);
  const label='通信兼容草稿 · '+environment;await first.locator('#nodeLabel').fill(label);await first.locator('#nodeLabel').blur();
  const draft=await poll(async()=>(await works()).drafts.find(d=>d.learnerId===learner.id&&d.graph.nodes.some(node=>node.label===label)),environment+' HTTP draft saved');
  await first.locator('#submitButton').click();await first.locator('#submitDialog').waitFor();
  await first.locator('#selfRatingGroup label:has(input[value="3"])').click();await first.locator('#submitForm [type=submit]').click();
  await first.locator('#submitDialog').waitFor({state:'hidden'});
  const submission=await poll(async()=>(await works()).submissions.find(s=>s.learnerId===learner.id&&s.source==='student'),environment+' HTTP self-assessment submitted');
  assert.deepEqual(submission.selfAssessment,{goalId:1,stars:3});assert.equal(submission.draftId,draft.id);
  assert.ok(submission.graph.nodes.some(node=>node.label===label));
  // A1 keeps native SSE; A2 closes every stream and must update through HTTP polling.
  await poll(()=>first.evaluate(()=>window.__communicationStreams.some(stream=>stream.readyState===EventSource.OPEN)),environment+' native SSE open');
  await poll(()=>second.evaluate(()=>window.__communicationStreams.some(stream=>stream.readyState===EventSource.OPEN)),environment+' second SSE open before closing');
  await second.evaluate(()=>window.__communicationStreams.forEach(stream=>stream.close()));
  assert.equal(await second.evaluate(()=>window.__communicationStreams.every(stream=>stream.readyState===EventSource.CLOSED)),true);
  let statePolls=0;second.on('request',request=>{if(new URL(request.url()).pathname===`/api/sessions/${room.id}/state`)statePolls++;});
  teacher.once('dialog',dialog=>dialog.accept());await teacher.locator('#chapters [data-chapter="2"]').click();
  await poll(()=>first.evaluate(()=>window.__communicationStates.some(session=>session.chapterId===2)),environment+' chapter received through SSE');
  await poll(()=>first.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),environment+' SSE chapter applied');
  await poll(()=>second.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),environment+' polling chapter applied');
  assert.ok(statePolls>0,'closed SSE client reads classroom state through HTTP');
  assert.equal(await second.evaluate(()=>window.__communicationStates.some(session=>session.chapterId===2)),false,'polling client receives no chapter-2 SSE');
  assert.equal((await api(secondContext,'/api/me')).learner.id,secondLearner.id);
  checks.push({environment,autoJoinRequests,learners:['A1','A2'],refreshRetainsIdentity:true,teacherAuthentication:true,draftSync:true,selfAssessment:3,chapterViaSSE:2,chapterViaPolling:2});
  await firstContext.close();await secondContext.close();await teacherContext.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,browser:await browser.version(),limitation:'Installed Chrome with AbortSignal.timeout removed is feature simulation, not a Win7/Chromium 99 hardware test.',checks,pageErrors:errors},null,2));
}finally{
 try{await browser?.close();}finally{try{if(app?.server.listening)await app.shutdown();else if(app?.db.isOpen)app.db.close();}finally{rmSync(dataDir,{recursive:true,force:true});}}
}
