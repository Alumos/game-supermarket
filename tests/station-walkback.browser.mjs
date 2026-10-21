// Fast acceptance for the two v1.3.19 changes: station walk-back and juice serving.
// One browser, one classroom, ~20 seconds. Run with `npm run test:station-walkback`.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClassroomServer} from '../server.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
  try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Playwright is required; set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-walkback-'));
const {server}=createClassroomServer({dataDir,teacherKey:'walkback-test'});
const checks=[],errors=[];
let browser;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  const teacherContext=await browser.newContext(),studentContext=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
  const teacher=await teacherContext.newPage(),student=await studentContext.newPage();
  for(const [name,page] of [['teacher',teacher],['student',student]])page.on('pageerror',error=>errors.push(`${name}: ${error.message}`));
  const api=async(context,path,body)=>{const response=await context.request.fetch(origin+path,{method:body?'POST':'GET',data:body}),data=await response.json();assert.ok(response.ok(),JSON.stringify(data));return data;};
  const poll=async(check,label,timeout=20000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(await check())return;await student.waitForTimeout(80);}throw new Error('Timed out: '+label);};

  await api(teacherContext,'/api/teacher/login',{key:'walkback-test'});
  let {session}=await api(teacherContext,'/api/sessions',{name:'回到上一站验收'});
  const command=async(action,extra={})=>{const latest=await api(teacherContext,`/api/sessions/${session.id}/state`);const result=await api(teacherContext,`/api/sessions/${session.id}/commands`,{commandId:crypto.randomUUID(),expectedVersion:latest.session.version,action,...extra});session=result.session;return result;};
  const station=ch=>poll(()=>student.locator('#chapterNumber').textContent().then(text=>text.endsWith(`0${ch}`)),`station ${ch}`);
  const tab=ch=>student.locator(`#chapters [data-chapter="${ch}"]`);

  await teacher.goto(origin+'/teacher.html');await student.goto(origin+'/');
  await poll(()=>student.locator('#accountButton').textContent().then(text=>/^A\d+$/.test(text)),'student joins');
  await command('chapter',{chapterId:1});await station(1);
  await poll(()=>student.locator('#submitButton').isEnabled(),'station 1 editable');

  // 1. Rating unlocks the next station and keeps the earlier one reachable.
  await student.locator('#submitButton').click();
  await student.locator('#selfRatingGroup label:has(input[value="3"])').click();
  await student.locator('#submitForm [type=submit]').click();
  await student.locator('#submitDialog').waitFor({state:'hidden'});
  await station(2);
  assert.equal(await tab(1).isEnabled(),true,'station 1 stays clickable after rating');
  assert.equal(await tab(3).isEnabled(),false,'station 3 stays locked until its rating');
  assert.equal(await tab(4).isEnabled(),false,'station 4 stays locked');
  checks.push('rating station 1 unlocks station 2 and leaves station 1 reachable; later stations stay locked');

  // 2. Real click walks back, and the draft for that station is restored.
  await tab(1).click();await station(1);
  assert.match(await student.locator('#chapters [data-chapter="1"]').getAttribute('class'),/active/);
  assert.equal(await student.locator('#submitButton').isEnabled(),true,'a visited station stays editable');
  checks.push('clicking station 1 returns to it and it remains editable');

  // 3. Walking forward again and rating advances from the frontier.
  await tab(2).click();await station(2);
  await student.locator('#submitButton').click();
  await student.locator('#selfRatingGroup label:has(input[value="2"])').click();
  await student.locator('#submitForm [type=submit]').click();
  await student.locator('#submitDialog').waitFor({state:'hidden'});
  await station(3);
  assert.equal(await tab(1).isEnabled(),true,'both earlier stations stay reachable');
  assert.equal(await tab(2).isEnabled(),true,'station 2 stays reachable');
  checks.push('rating the frontier still advances to station 3 with stations 1 and 2 reachable');

  // 4. Re-rating an older station records stars without jumping ahead.
  await tab(2).click();await station(2);
  await student.locator('#submitButton').click();
  await student.locator('#selfRatingGroup label:has(input[value="1"])').click();
  await student.locator('#submitForm [type=submit]').click();
  await student.locator('#submitDialog').waitFor({state:'hidden'});
  await student.waitForTimeout(700);
  assert.equal(await student.locator('#chapterNumber').textContent().then(t=>t.endsWith('02')),true,'re-rating an older station does not jump to the next one');
  await station(2);
  checks.push('re-rating an older station keeps the student on it instead of jumping ahead');

  // 5. Station 2 now carries five operations ending in 果汁出品.
  const juice=await student.evaluate(async()=>{
    const engine=await import('/shared/engine.mjs');
    return {labels:engine.availableActions(2,'fresh-juice').map(action=>action.label),completed:engine.simulate(engine.exampleGraph(2,'fresh-juice')).completed,goal:engine.TASKS.find(task=>task.id==='fresh-juice').goal};
  });
  assert.deepEqual(juice.labels,['清洗橙子','去皮切块','放入橙肉','启动机器榨汁','果汁出品']);
  assert.equal(juice.completed,true,'the five-step example still completes');
  assert.match(juice.goal,/五步/);
  checks.push('fruit station exposes five operations ending in 果汁出品 and its example completes');

  // 6. A station behind the teacher's chapter closes again.
  await command('chapter',{chapterId:3});await station(3);
  assert.equal(await tab(1).isEnabled(),false,'stations behind the teacher are closed');
  assert.equal(await tab(2).isEnabled(),false,'stations behind the teacher are closed');
  assert.equal(await tab(4).isEnabled(),false,'the next station is still locked');
  checks.push('a teacher chapter command closes stations behind it while keeping the next one locked');

  assert.deepEqual(errors,[],'no page errors');
  console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
  rmSync(dataDir,{recursive:true,force:true});
}
