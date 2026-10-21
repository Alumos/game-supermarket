// Isolated real-classroom acceptance of the teacher's sorting/formed draft views.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createClassroomServer} from '../server.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
  try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Playwright is required.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-fruit-classroom-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-fruit-classroom-test'});
const output=resolve(process.env.SUPERMARKET_TEST_OUTPUT||'/tmp/supermarket-fruit-flow-qa');
assert.ok(output.startsWith('/tmp/')||output.startsWith('/private/tmp/'),'screenshots must stay under /tmp');mkdirSync(output,{recursive:true});
const checks=[],errors=[];
let browser,teacher,student;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  const teacherContext=await browser.newContext({viewport:{width:1440,height:1000}}),studentContext=await browser.newContext({viewport:{width:1440,height:1000}});
  teacher=await teacherContext.newPage();student=await studentContext.newPage();
  for(const [name,page] of [['teacher',teacher],['student',student]])page.on('pageerror',error=>errors.push(`${name}: ${error.message}`));
  async function api(context,path,{method='GET',body,status=200}={}){const response=await context.request.fetch(origin+path,{method,data:body}),data=await response.json();assert.equal(response.status(),status,JSON.stringify(data));return data;}
  async function poll(check,label,timeout=30000){const until=Date.now()+timeout;while(Date.now()<until){const result=await check();if(result)return result;await student.waitForTimeout(100);}throw new Error(`Timed out: ${label}`);}
  async function idle(){await student.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting,.flow-forming'));await student.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  const actions=()=>student.locator('#flowNodes .flow-node:not(.terminal)');
  async function append(action){
    await idle();const source=student.locator(`#actionCards [data-action="${action}"]`),count=await actions().count();await source.scrollIntoViewIfNeeded();
    const from=await source.boundingBox(),target=await(count?actions().last():student.locator('#flowScroll')).boundingBox();assert.ok(from&&target);
    await student.mouse.move(from.x+from.width/2,from.y+from.height/2);await student.mouse.down();
    await student.mouse.move(target.x+target.width/2,target.y+target.height*(count ? .9 : .5),{steps:18});
    assert.equal(await student.locator('.drag-ghost').count(),1);await student.waitForTimeout(120);await student.mouse.up();await idle();
    assert.equal(await actions().count(),count+1,'real student drag adds one action');
  }

  await teacher.goto(origin+'/teacher.html');await teacher.locator('#key').fill('isolated-fruit-classroom-test');await teacher.locator('#login-form button').click();await teacher.locator('#login-dialog').waitFor({state:'hidden'});
  const {session}=await api(teacherContext,'/api/sessions',{method:'POST',body:{name:'水果排序与生成 · 教师同步验收'},status:201});
  await teacher.reload();await teacher.locator('#room-title').filter({hasText:'教师同步验收'}).waitFor();
  teacher.once('dialog',dialog=>dialog.accept());
  await teacher.locator('#chapters [data-chapter="2"]').click();
  await poll(async()=>(await api(teacherContext,`/api/sessions/${session.id}/state`)).session.chapterId===2,'teacher selects chapter 2');
  assert.equal(await teacher.locator('#practice').isDisabled(),true,'chapter switch already opens practice');
  await poll(async()=>(await api(teacherContext,`/api/sessions/${session.id}/state`)).session.phase==='practice','teacher opens fruit practice');
  await student.goto(origin+'/');await poll(()=>student.locator('#accountButton').textContent().then(text=>text.trim()==='A1'),'student automatically joins');
  await student.locator('#transition').waitFor({state:'hidden'});await poll(()=>student.locator('[data-action=wash_orange]').isEnabled(),'fruit palette unlocked');
  const learner=(await api(studentContext,'/api/me')).learner;
  assert.equal(learner.sessionId,session.id);assert.match(await student.locator('#sceneTitle').textContent(),/水果/);
  for(const action of ['wash_orange','peel_cut','add_orange','start_juicer','serve_juice'])await append(action);
  const order=await actions().evaluateAll(elements=>elements.map(el=>el.dataset.node));
  const works=()=>api(teacherContext,`/api/sessions/${session.id}/works`);
  const sorting=await poll(async()=>{const data=await works();return data.drafts.find(d=>d.learnerId===learner.id&&d.graph.flowchartStage==='sorting'&&d.graph.nodes.filter(n=>n.kind==='action').length===5);},'sorting draft reaches classroom SQLite');
  assert.equal(sorting.graph.edges.length,0);
  await teacher.locator('[data-work-chapter="2"]').click();
  await poll(()=>teacher.locator(`#learners tr[data-learner-row="${learner.id}"]`).textContent().then(text=>text.includes(`草稿 v${sorting.revision} 已保存`)),'teacher receives sorting draft without page reload');
  await teacher.locator(`[data-view="${learner.id}"]`).click();await teacher.locator('#detail-dialog').waitFor({state:'visible'});
  const detail=teacher.locator('.work-detail');
  assert.deepEqual(await detail.locator('.graph .flow-node').evaluateAll(elements=>elements.map(el=>el.dataset.node)),order,'teacher sees student operation order');
  assert.equal(await detail.locator('.graph .start,.graph .end,.flow-arrow,.run-error,.flow-node.error').count(),0,'sorting view has no terminals, arrows or error treatment');
  assert.match(await detail.textContent(),/学生正在排序，形成流程图后可回放/);
  assert.equal(await detail.locator('[data-replay="start"],.world-preview').count(),0,'unformed sorting cannot be replayed');
  await teacher.screenshot({path:join(output,'fruit-teacher-sorting.png'),fullPage:true});await teacher.locator('#detail-dialog [data-close]').click();
  checks.push('teacher opens chapter 2 practice; automatically joined student drags five cards; synced teacher view preserves sorting order without terminals, arrows, errors or replay');

  await student.locator('#chainButton').click();await student.waitForFunction(()=>document.querySelector('#flowCanvas').classList.contains('flow-forming'));await idle();
  const formed=await poll(async()=>{const data=await works();return data.drafts.find(d=>d.learnerId===learner.id&&d.graph.flowchartStage==='formed'&&d.graph.edges.length===6);},'formed draft reaches classroom SQLite');
  await poll(()=>teacher.locator(`#learners tr[data-learner-row="${learner.id}"]`).textContent().then(text=>text.includes(`草稿 v${formed.revision} 已保存`)),'teacher receives formed draft without page reload');
  await teacher.locator(`[data-view="${learner.id}"]`).click();await detail.locator('.world-preview canvas').waitFor();
  assert.equal(await detail.locator('.graph .flow-node.start,.graph .flow-node.end').count(),2);
  assert.equal(await detail.locator('.graph .flow-arrow').count(),6);
  assert.equal(await detail.locator('.run-error,.flow-node.error').count(),0);
  assert.deepEqual(await detail.locator('.graph .flow-node.action').evaluateAll(elements=>elements.map(el=>el.dataset.node)),order);
  await detail.locator('[data-replay="start"]').click();
  await poll(()=>detail.locator('.graph .replaying').count().then(count=>count===1),'teacher replay highlights a real student operation');
  assert.equal(await detail.locator('[data-replay="stop"]').isEnabled(),true);assert.match(await detail.locator('.playback-status').textContent(),/第\d+步/);
  await teacher.screenshot({path:join(output,'fruit-teacher-formed-replay.png'),fullPage:true});
  await detail.locator('[data-replay="stop"]').click();assert.match(await detail.locator('.playback-status').textContent(),/回放已停止/);
  const afterReplay=await works();assert.equal(afterReplay.runs.length,0,'teacher replay does not create a student run');
  assert.deepEqual(afterReplay.drafts.find(d=>d.id===formed.id).graph,formed.graph,'teacher replay preserves the student draft');
  checks.push('student formation syncs two terminals and seven arrows to teacher; teacher can replay/stop the formed draft without changing student work or creating a run');
  assert.deepEqual(errors,[]);
  const report={ok:true,checks,pageErrors:errors,screenshots:output};writeFileSync(join(output,'classroom-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(teacher)await teacher.screenshot({path:join(output,'fruit-classroom-failure.png'),fullPage:true}).catch(()=>{});throw error;
}finally{await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});}
