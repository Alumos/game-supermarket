// Real student page: bounded idle traffic, prompt classroom changes and HTTP
// recovery without SSE. The server/database and browser profiles are isolated.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClassroomServer} from '../server.mjs';
import {exampleGraph} from '../shared/engine.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
  try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Playwright is required.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-sync-traffic-'));
const app=createClassroomServer({dataDir,teacherKey:'isolated-sync-test'});
const checks=[],errors=[],requests=[];
let holdStudentStates=false;
app.server.prependListener('request',(request,response)=>{
  if(!request.url.includes('/stream')||!(request.headers.cookie||'').includes('sm_student='))return;
  const write=response.write.bind(response);
  response.write=(chunk,...args)=>holdStudentStates&&String(chunk).startsWith('event: state')?true:write(chunk,...args);
});
let browser;
try{
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  const teacher=await browser.newContext(),student=await browser.newContext({viewport:{width:1180,height:820},serviceWorkers:'block'}),peer=await browser.newContext();
  await student.addInitScript(()=>{
    delete AbortSignal.timeout;
    window.__streams=[];
    const Native=window.EventSource;
    window.EventSource=class extends Native{constructor(...args){super(...args);window.__streams.push(this);}};
  });
  async function api(context,path,{method='GET',body,status=200}={}){
    const response=await context.request.fetch(origin+path,{method,data:body}),data=await response.json();
    assert.equal(response.status(),status,JSON.stringify(data));return data;
  }
  async function command(session,action,extra={}){
    return (await api(teacher,`/api/sessions/${session.id}/commands`,{method:'POST',body:{action,...extra,commandId:crypto.randomUUID(),expectedVersion:session.version}})).session;
  }
  await api(teacher,'/api/teacher/login',{method:'POST',body:{key:'isolated-sync-test'}});
  let {session}=await api(teacher,'/api/sessions',{method:'POST',body:{name:'低流量同步验收'},status:201});
  session=await command(session,'practice');
  const page=await student.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/api/'))requests.push({path,at:Date.now()});});
  await page.goto(origin+'/');await page.waitForFunction(()=>document.querySelector('#accountButton').textContent==='A1'&&!document.querySelector('#runButton').disabled);
  await page.waitForFunction(()=>window.__streams.some(stream=>stream.readyState===EventSource.OPEN));
  await page.waitForTimeout(500);
  const count=path=>requests.filter(request=>request.path===path).length;
  assert.equal(count('/api/student/ack'),1,'join and initial SSE share one chapter acknowledgement');
  const initial=await api(student,'/api/me');
  const joined=await api(peer,'/api/student/auto-join',{method:'POST',body:{deviceToken:'isolated-peer-device-token-123456789'}});
  const graph=exampleGraph(1,'drink-swap','best');
  const beforePeer=count('/api/student/ack');
  for(let revision=0;revision<20;revision++){
    await api(peer,`/api/student/drafts/${joined.assignment.draftId}`,{method:'PUT',body:{graph,baseRevision:revision,mutationId:`peer-save-${revision}`}});
  }
  await page.waitForTimeout(400);
  assert.equal(count('/api/student/ack'),beforePeer,'another learner saving never produces a room-wide acknowledgement cascade');
  checks.push('twenty peer saves leave the student canvas and acknowledgement count unchanged');

  const idleStart=requests.length;
  await page.waitForTimeout(13000);
  const idle=requests.slice(idleStart),acks=idle.filter(request=>request.path==='/api/student/ack').length;
  assert.ok(acks<=2,`presence has bounded traffic: ${acks} acknowledgements in 13 seconds`);
  assert.equal(idle.filter(request=>request.path===`/api/sessions/${session.id}/state`).length,0,'healthy SSE needs no duplicate state polling');
  assert.ok(idle.filter(request=>request.path==='/api/student/current').length<=1,'healthy SSE reduces discovery polling');
  checks.push({idleSeconds:13,requests:idle.length,presenceAcknowledgements:acks,duplicateStatePolls:0});

  const chapterStart=Date.now();session=await command(session,'chapter',{chapterId:2});
  await page.waitForFunction(()=>document.querySelector('#sceneTitle').textContent.includes('水果'),null,{timeout:5000});
  await page.waitForFunction(()=>!document.querySelector('#submitButton').disabled);
  let acknowledged=false;
  for(let attempt=0;attempt<30&&!acknowledged;attempt++){
    const state=await api(teacher,`/api/sessions/${session.id}/state`);
    acknowledged=state.learners.find(learner=>learner.id===initial.learner.id)?.appliedVersion===session.version;
    if(!acknowledged)await page.waitForTimeout(100);
  }
  assert.ok(acknowledged,'a new chapter is acknowledged promptly even inside the presence throttle');
  checks.push({chapterViaSSE:2,observedMilliseconds:Date.now()-chapterStart});

  // Model a proxy that keeps the stream OPEN while silently buffering events.
  holdStudentStates=true;session=await command(session,'chapter',{chapterId:3});
  assert.equal(await page.evaluate(()=>window.__streams.some(stream=>stream.readyState===EventSource.OPEN)),true);
  await page.waitForFunction(()=>document.querySelector('#sceneTitle').textContent.includes('实践'),null,{timeout:20000});
  holdStudentStates=false;
  checks.push('presence response detects a silently stalled OPEN stream and restores the chapter through HTTP');

  // Closing the real stream must preserve the existing HTTP fallback.
  await page.evaluate(()=>window.__streams.forEach(stream=>stream.close()));
  session=await command(session,'chapter',{chapterId:4});
  await page.waitForFunction(()=>document.querySelector('#sceneTitle').textContent.includes('配送'),null,{timeout:20000});
  assert.equal((await api(student,'/api/me')).learner.id,initial.learner.id);
  checks.push('closed SSE falls back to HTTP and keeps the same learner identity');

  await page.reload();await page.waitForFunction(()=>window.__streams.some(stream=>stream.readyState===EventSource.OPEN));
  const {session:next}=await api(teacher,'/api/sessions',{method:'POST',body:{name:'新课堂即刻接入'},status:201});
  await page.waitForFunction(name=>document.querySelector('#classNotice').textContent.includes(name),next.name,{timeout:7000});
  assert.equal((await api(student,'/api/me')).learner.sessionId,next.id);
  checks.push('a current-classroom SSE change joins the new classroom without waiting for the slower discovery timer');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{
  await browser?.close();await app.shutdown();rmSync(dataDir,{recursive:true,force:true});
}
