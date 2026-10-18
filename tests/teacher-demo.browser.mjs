// Real Chrome acceptance: authenticated teacher demonstration stays outside class.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createClassroomServer} from '../server.mjs';
import {TASKS} from '../shared/engine.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-teacher-demo-'));
const password='isolated-demo-acceptance',previousPassword=process.env.SUPERMARKET_TEACHER_PASSWORD;
process.env.SUPERMARKET_TEACHER_PASSWORD=password;
let app;
try{app=createClassroomServer({dataDir});}finally{if(previousPassword===undefined)delete process.env.SUPERMARKET_TEACHER_PASSWORD;else process.env.SUPERMARKET_TEACHER_PASSWORD=previousPassword;}
const {server}=app,checks=[],errors=[];
let browser,page;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),teacher=await browser.newContext();
 page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 async function api(client,path,{method='GET',body,status=200}={}){const response=await client.request.fetch(origin+path,{method,data:body}),data=await response.json();assert.equal(response.status(),status,JSON.stringify(data));return data;}
 async function poll(check,label,timeout=30000){const until=Date.now()+timeout;let last;while(Date.now()<until){last=await check();if(last)return last;await new Promise(resolve=>setTimeout(resolve,120));}throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);}
 async function stored(key){return page.evaluate(async key=>(await import('/db.js')).get(key),key);}
 async function records(prefix){return page.evaluate(async prefix=>(await import('/db.js')).all(prefix),prefix);}
 async function screenshot(name){if(!process.env.SUPERMARKET_TEST_OUTPUT)return;const output=resolve(process.env.SUPERMARKET_TEST_OUTPUT);mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,name+'.png'),fullPage:true});}
 async function drag(action){await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));const source=page.locator(`[data-action="${action}"]`),end=page.locator('#flowNodes .flow-node').last(),before=await page.locator('#flowNodes .flow-node').count();await source.scrollIntoViewIfNeeded();await end.scrollIntoViewIfNeeded();const a=await source.boundingBox(),b=await end.boundingBox();assert.ok(a&&b);await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:14});await page.mouse.up();await page.waitForFunction(count=>document.querySelectorAll('#flowNodes .flow-node').length===count,before+1);}
 async function chapter(id){await page.locator(`#chapters [data-chapter="${id}"]`).click();await poll(()=>page.locator(`#chapters [data-chapter="${id}"]`).getAttribute('class').then(value=>value.includes('active')),`chapter ${id}`);await poll(()=>page.locator('#runButton').isEnabled(),`chapter ${id} editable`);}
 async function label(text){await page.locator('#nodeLabel').fill(text);await page.locator('#nodeLabel').blur();}
 async function demoReady(){await poll(()=>page.locator('body').getAttribute('class').then(value=>value?.includes('teacher-demo-mode')),'teacher demo active');await poll(()=>page.locator('#runButton').isEnabled(),'demo editable');assert.equal(await page.locator('#chapters button:enabled').count(),4);assert.equal(await page.locator('#welcome').isVisible(),false);}

 // Preserve a real free-practice draft before attempting the protected URL.
 await page.goto(origin+'/');await poll(()=>page.locator('#connection').textContent().then(text=>!text.includes('正在连接')),'initial bootstrap');if(await page.locator('#welcome').isVisible())await page.locator('#practiceButton').click();await poll(()=>page.locator('#runButton').isEnabled(),'initial practice');
 await drag('move_crate');await label('独立自由体验草稿');
 const practice=await poll(async()=>{const value=await stored('draft:practice:1:drink-swap');return value?.graph.nodes.some(node=>node.label==='独立自由体验草稿')&&value;},'practice persisted');
 const authRequests=[];const authWatch=request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/student/')||url.pathname.endsWith('/stream'))authRequests.push(url.pathname);};
 page.on('request',authWatch);await page.goto(origin+'/?mode=demo');await page.locator('#teacherDemoDialog').waitFor();await page.locator('#teacherDemoCancel').click();await page.waitForURL(origin+'/');await poll(()=>page.locator('#flowNodes').textContent().then(text=>text.includes('独立自由体验草稿')),'cancel restores practice');assert.deepEqual((await stored('draft:practice:1:drink-swap')).graph,practice.graph);authRequests.length=0;await page.goto(origin+'/?mode=demo');await page.locator('#teacherDemoDialog').waitFor();await screenshot('teacher-demo-login');
 assert.equal(await page.locator('body').evaluate(body=>body.classList.contains('teacher-demo-mode')),false);assert.equal(await page.locator('#runButton').isDisabled(),true);
 await page.locator('#teacherDemoPassword').fill('incorrect');await page.locator('#teacherDemoForm [type=submit]').click();await poll(()=>page.locator('#teacherDemoError').textContent().then(Boolean),'wrong password error');assert.equal(await page.locator('#teacherDemoDialog').isVisible(),true);
 assert.equal((await api(context,'/api/me')).role,null);assert.deepEqual(authRequests,[],'unauthenticated demo never joins a class');
 await page.locator('#teacherDemoPassword').fill(password);await Promise.all([page.waitForURL('**/?mode=demo'),page.locator('#teacherDemoForm [type=submit]').click()]);await demoReady();
 page.off('request',authWatch);assert.deepEqual(authRequests,[]);assert.deepEqual((await stored('draft:practice:1:drink-swap')).graph,practice.graph,'unauthenticated placeholder never overwrites free practice');
 assert.equal(await page.locator('#flowNodes .flow-node').count(),2);await drag('move_crate');await label('教师独立演示草稿');
 const demoDraft=await poll(async()=>{const value=await stored('draft:teacher-demo:1:drink-swap');return value?.graph.nodes.some(node=>node.label==='教师独立演示草稿')&&value;},'demo persisted');
 await page.locator('#teacherDemoButton').click();await page.waitForURL(origin+'/');await poll(()=>page.locator('#flowNodes').textContent().then(text=>text.includes('独立自由体验草稿')),'practice returns');assert.deepEqual((await stored('draft:practice:1:drink-swap')).graph,practice.graph);
 checks.push('protected demo URL rejects wrong password, accepts teacher password, and preserves separate free-practice and teacher drafts');

 await api(teacher,'/api/teacher/login',{method:'POST',body:{key:password}});
 const {session}=await api(teacher,'/api/sessions',{method:'POST',body:{name:'教师演示隔离验收'},status:201});
 async function command(action){const current=await api(teacher,`/api/sessions/${session.id}/state`);return api(teacher,`/api/sessions/${session.id}/commands`,{method:'POST',body:{action,commandId:crypto.randomUUID(),expectedVersion:current.session.version}});}
 const works=async()=>{const {serverTime,...data}=await api(teacher,`/api/sessions/${session.id}/works`);data.learners=data.learners.map(({online,...learner})=>learner);return data;};
 await poll(()=>page.locator('#accountButton').textContent().then(text=>text.trim()==='A1'),'A1 classroom joined');await command('practice');await poll(()=>page.locator('#runButton').isEnabled(),'class practice');await drag('move_crate');await label('A1 正式课堂草稿');
 const learner=(await page.evaluate(async()=>{const response=await fetch('/api/me',{headers:{'X-Supermarket-Role':'student'}});return response.json();})).learner;
 await poll(async()=>(await works()).drafts.some(draft=>draft.graph.nodes.some(node=>node.label==='A1 正式课堂草稿')),'class draft synchronized');
 await command('pause');await poll(()=>page.locator('#runButton').isDisabled(),'class paused');await poll(()=>page.locator('#classNotice').textContent().then(text=>text.includes('暂停')),'pause applied');
 assert.deepEqual((await context.cookies()).map(cookie=>cookie.name).filter(name=>/^sm_(teacher|student)$/.test(name)).sort(),['sm_student','sm_teacher']);
 const participant=await stored('participant');await page.locator('#teacherDemoButton').click();await page.waitForURL('**/?mode=demo');await demoReady();
 assert.equal(await page.locator('#teacherDemoDialog').isVisible(),false);assert.match(await page.locator('#flowNodes').textContent(),/教师独立演示草稿/);assert.deepEqual((await stored('draft:teacher-demo:1:drink-swap')).graph,demoDraft.graph);
 await screenshot('teacher-demo-authenticated');const baseline=await works(),classState=(await api(teacher,`/api/sessions/${session.id}/state`)).session;
 const demoRequests=[];const demoWatch=request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/student/')||url.pathname.endsWith('/stream'))demoRequests.push(url.pathname);};page.on('request',demoWatch);
 for(const id of [2,3,4,1,3])await chapter(id);
 const taskDrafts=new Map();
 for(const task of TASKS.filter(task=>task.chapterId===3)){
  await page.locator(`[data-practice-task="${task.id}"]`).click();await poll(()=>page.locator(`[data-practice-task="${task.id}"]`).getAttribute('aria-pressed').then(value=>value==='true'),`${task.id} selected`);await poll(()=>page.locator('#runButton').isEnabled(),`${task.id} editable`);
  assert.equal(await page.locator('#flowNodes .flow-node').count(),2);
  for(const action of task.id==='tea'?task.actions:task.actions.slice(0,1))await drag(action.actionId);
  if(task.id==='tea')await page.locator('#chainButton').click();
  const expected=task.id==='tea'?7:3;taskDrafts.set(task.id,await poll(async()=>{const value=await stored(`draft:teacher-demo:3:${task.id}`);return value?.graph.nodes.length===expected&&value;},`${task.id} independent draft`));
 }
 await page.locator('[data-practice-task="tea"]').click();await poll(()=>page.locator('#flowNodes .flow-node').count().then(count=>count===7),'tea restored');
 await page.locator('#runButton').click();await poll(async()=>(await records('run:teacher-demo:')).find(({value})=>value.taskId==='tea'&&value.valid),'local valid demo run',60000);await poll(()=>page.locator('#submitButton').isEnabled(),'demo submission enabled');
 await page.locator('#submitButton').click();await page.locator('#selfRatingGroup input[value="3"]').check();await page.locator('#submitForm [type=submit]').click();await page.locator('#submitDialog').waitFor({state:'hidden'});
 assert.equal((await records('submission:teacher-demo:')).length,1);
 await page.reload();await demoReady();assert.equal(await page.locator('[data-practice-task="tea"]').getAttribute('aria-pressed'),'true');assert.deepEqual((await stored('draft:teacher-demo:3:tea')).graph,taskDrafts.get('tea').graph);
 // Exercise reconnect/visibility hooks and allow a complete ordinary polling period.
 await page.evaluate(()=>{window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(8500);
 assert.deepEqual(demoRequests,[],'demo never opens student API or classroom SSE');assert.deepEqual(await stored('participant'),participant,'real participant remains untouched');assert.deepEqual(await works(),baseline,'demo makes no classroom writes');assert.deepEqual((await api(teacher,`/api/sessions/${session.id}/state`)).session,classState);
 checks.push('existing teacher and student cookies enter demo from paused class without login; all four scenes and four practice tasks edit independently');
 checks.push('valid runs, self-assessment, refresh and reconnect hooks stay local without student APIs, SSE, participant changes or classroom writes');
 page.off('request',demoWatch);await page.locator('#teacherDemoButton').click();await page.waitForURL(origin+'/');await poll(()=>page.locator('#accountButton').textContent().then(text=>text.trim()==='A1'),'A1 restored');await poll(()=>page.locator('#flowNodes').textContent().then(text=>text.includes('A1 正式课堂草稿')),'class draft restored');assert.equal(await page.locator('#runButton').isDisabled(),true);assert.equal((await stored('participant')).learner.id,learner.id);assert.equal((await works()).learners.length,1);
 checks.push('exit restores the same A1, original classroom draft and paused classroom controls');
 if(process.env.SUPERMARKET_TEST_OUTPUT){const output=resolve(process.env.SUPERMARKET_TEST_OUTPUT);mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,'teacher-demo-restored-student.png'),fullPage:true});}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});}
