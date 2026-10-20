// Real Chrome acceptance of per-chapter 1–3 star self-assessment, touch,
// historical ratings, task isolation, offline replay and legacy text submissions.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createClassroomServer} from '../server.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
 try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Playwright is required.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-self-assessment-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-self-assessment'});
// Screenshots are opt-in and always temporary, never repository artifacts.
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output){assert.ok(output.startsWith('/tmp/')||output.startsWith('/private/tmp/'),'SUPERMARKET_TEST_OUTPUT must be under /tmp');mkdirSync(output,{recursive:true});}
const goals={1:/顺序结构.*特点/,2:/步骤.*流程图/,3:/算法思维/,4:/算法优化/};
const checks=[],errors=[];
let browser,student,teacher,session;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const teacherContext=await browser.newContext({viewport:{width:1440,height:1000}});
 const studentContext=await browser.newContext({viewport:{width:1024,height:768},hasTouch:true});
 await studentContext.addInitScript(()=>{const Native=window.EventSource;window.__ratingTestStreams=[];window.EventSource=class extends Native{constructor(...args){super(...args);window.__ratingTestStreams.push(this);}};});
 teacher=await teacherContext.newPage();student=await studentContext.newPage();
 for(const [name,page] of [['teacher',teacher],['student',student]])page.on('pageerror',error=>errors.push(`${name}: ${error.message}`));
 async function api(context,path,{method='GET',body,status=200}={}){
  const response=await context.request.fetch(origin+path,{method,data:body}),data=await response.json();
  assert.equal(response.status(),status,JSON.stringify(data));return data;
 }
 async function poll(check,label,timeout=30000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){last=await check();if(last)return last;await new Promise(resolve=>setTimeout(resolve,120));}
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
 }
 const works=()=>api(teacherContext,`/api/sessions/${session.id}/works`);
 const current=()=>api(studentContext,`/api/sessions/${session.id}/state`);
 const studentSubs=data=>data.submissions.filter(sub=>sub.source==='student');
 async function command(action,extra={}){
  const state=await api(teacherContext,`/api/sessions/${session.id}/state`);
  const result=await api(teacherContext,`/api/sessions/${session.id}/commands`,{method:'POST',body:{commandId:crypto.randomUUID(),expectedVersion:state.session.version,action,...extra}});
  session=result.session;return result;
 }
 async function chapter(id){
  await command('chapter',{chapterId:id});
  await poll(()=>student.locator('#sceneTitle').textContent().then(text=>text.includes({1:'饮料',2:'水果',3:'实践',4:'配送'}[id])),`chapter ${id} enters`);
  await poll(()=>student.locator('#submitButton').isEnabled(),`chapter ${id} opens directly`);
 }
 async function openRating(id){
  await student.locator('#submitButton').tap();await student.locator('#submitDialog').waitFor({state:'visible'});
  assert.match(await student.locator('#submitRatingGoal').textContent(),goals[id]);
  assert.equal(await student.locator('#selfRatingGroup input[name=selfStars]').count(),3);
  assert.deepEqual(await student.locator('#selfRatingGroup input[name=selfStars]').evaluateAll(inputs=>inputs.map(input=>input.value)),['1','2','3']);
  assert.equal(await student.locator('#explanation,#submitPrompt,#submitHint').count(),0);
  assert.equal(await student.locator('#submitForm [type=submit]').isDisabled(),true,'each dialog starts without a rating');
  assert.equal(await student.locator('#selfRatingGroup input:checked').count(),0);
 }
 async function chooseStars(stars){
  const input=student.locator(`#selfRatingGroup input[name=selfStars][value="${stars}"]`);
  const label=student.locator(`#selfRatingGroup label:has(input[name=selfStars][value="${stars}"])`);
  // Touch the label, exercising the visible star target even if input is visually hidden.
  await label.tap();assert.equal(await input.isChecked(),true);
  assert.equal(await student.locator('#selfRatingGroup input:checked').count(),1);
  assert.equal(await student.locator('#submitForm [type=submit]').isEnabled(),true);
 }
 async function submitRating(id,stars,{offline=false}={}){
  const before=offline?null:new Set(studentSubs(await works()).map(sub=>sub.id));
  await openRating(id);await chooseStars(stars);
  if(output&&id===1&&stars===1)await student.screenshot({path:join(output,'self-assessment-tablet-1-star.png')});
  await student.locator('#submitForm [type=submit]').tap();await student.locator('#submitDialog').waitFor({state:'hidden'});
  if(offline)return;
  const record=await poll(async()=>studentSubs(await works()).find(sub=>!before.has(sub.id)),`chapter ${id}, ${stars} stars uploaded`);
  assert.deepEqual(record.selfAssessment,{goalId:id,stars});assert.equal(record.chapterId,id);
  assert.equal(record.explanation||'','');return record;
 }
 async function history(){await student.locator('#historyButton').tap();await student.locator('#historyDialog').waitFor({state:'visible'});return student.locator('#historyList');}
 async function closeHistory(){await student.locator('#historyDialog .dialog-close').tap();}
 async function chooseTask(id){
  await student.locator(`[data-practice-task="${id}"]`).tap();
  await poll(()=>student.locator(`[data-practice-task="${id}"]`).getAttribute('aria-pressed').then(value=>value==='true'),`${id} selected`);
  await poll(async()=>(await current()).assignment.taskId===id,`${id} server assignment`);
  await poll(()=>student.locator('#submitButton').isEnabled(),`${id} loaded`);
 }
 await api(teacherContext,'/api/teacher/login',{method:'POST',body:{key:'isolated-self-assessment'}});
 ({session}=await api(teacherContext,'/api/sessions',{method:'POST',body:{name:'每章三星自评验收'},status:201}));
 await teacher.goto(origin+'/teacher.html');await teacher.locator('#room-title').filter({hasText:'三星自评'}).waitFor();
 await student.goto(origin+'/');await poll(()=>student.locator('#accountButton').textContent().then(text=>text.trim()==='A1'),'automatic entry');
 const learnerId=(await current()).learner.id;
 await teacher.locator('#learners .assessment-unrated').waitFor();assert.equal(await teacher.locator('#learners .assessment-stars').count(),0,'no automatic initial self-assessment');
 await command('practice');await poll(()=>student.locator('#submitButton').isEnabled(),'chapter 1 opens');
 // A tap on a disabled submit cannot create an unassessed student submission.
 await openRating(1);const beforeEmpty=studentSubs(await works()).length;
 const submitBounds=await student.locator('#submitForm [type=submit]').boundingBox();
 await student.touchscreen.tap(submitBounds.x+submitBounds.width/2,submitBounds.y+submitBounds.height/2);
 await student.waitForTimeout(150);assert.equal(await student.locator('#submitDialog').isVisible(),true);
 assert.equal(studentSubs(await works()).length,beforeEmpty);
 // A cancelled choice must not silently carry forward into a later submission.
 await chooseStars(3);if(output)await student.screenshot({path:join(output,'self-assessment-tablet-3-stars.png')});await student.locator('#submitDialog .dialog-close').tap();
 const chapter1First=await submitRating(1,1);
 await poll(()=>student.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),'first evaluation advances to fruit');await chapter(1);
 const chapter1Latest=await submitRating(1,3);
 assert.notEqual(chapter1First.id,chapter1Latest.id);
 checks.push('tablet touch selects exactly one of 1–3 stars; unselected submit is disabled; cancellation resets the choice; repeat submissions preserve different ratings');
 await chapter(2);const chapter2=await submitRating(2,2);
 await chapter(3);await chooseTask('tea');const tea=await submitRating(3,1);
 await poll(()=>student.locator('#sceneTitle').textContent().then(text=>text.includes('配送')),'practice evaluation advances to delivery');await chapter(3);
 await chooseTask('fish');const fish=await submitRating(3,3);
 assert.equal(tea.taskId,'tea');assert.equal(fish.taskId,'fish');
 await chapter(4);
 // Offline submission must retain chapter 4 goal and stars in the durable queue.
 await studentContext.setOffline(true);await student.evaluate(()=>{for(const stream of window.__ratingTestStreams||[])stream.close();});
 await poll(()=>student.locator('#connection').textContent().then(text=>text.includes('离线')),'browser offline event is applied');
 await submitRating(4,2,{offline:true});
 const queued=await student.evaluate(async id=>(await (await import('/db.js')).get(`queue:${id}`,[])).filter(item=>item.kind==='submission'),learnerId);
 assert.equal(queued.length,1);assert.deepEqual(queued[0].submission.selfAssessment,{goalId:4,stars:2});
 assert.equal(queued[0].offline,true);assert.equal(queued[0].graph.chapterId,4);
 assert.equal(studentSubs(await works()).some(sub=>sub.chapterId===4),false);
 const offlineHistory=await history();assert.match(await offlineHistory.textContent(),goals[4]);await closeHistory();
 // While the device is disconnected the teacher changes chapter. The old goal
 // must survive replay instead of becoming the new chapter's assessment.
 await command('chapter',{chapterId:2});await studentContext.setOffline(false);
 await poll(()=>student.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),'reconnected chapter 2');
 const chapter4=await poll(async()=>studentSubs(await works()).find(sub=>sub.chapterId===4),'offline chapter 4 rating replayed');
 assert.deepEqual(chapter4.selfAssessment,{goalId:4,stars:2});assert.equal(chapter4.offline,true);
 await poll(()=>student.evaluate(async id=>(await (await import('/db.js')).get(`queue:${id}`,[])).length===0,learnerId),'offline queue drains');
 checks.push('all four chapters expose their own learning goal; chapter 4 offline self-assessment survives classroom advancement and reconnect');
 // Upgrade compatibility: replay an actual old-format, valid-task text queue.
 // This deliberately lacks selfAssessment; it must remain readable and must not
 // replace the existing assessed submission with an invented rating.
 const legacyText='旧版离线想法：清洗橙子后去皮，再放入橙肉。';
 await student.evaluate(async({id,text})=>{
  const db=await import('/db.js'),engine=await import('/shared/engine.mjs'),graph=engine.exampleGraph(2,'fresh-juice');
  const item={id:'legacy-text-queue',mutationId:'legacy-text-mutation',kind:'submission',key:`draft:${id}:2:fresh-juice`,graph,offline:true,createdAt:Date.now(),submission:{submissionId:'legacy-text-submission',source:'student',explanation:text}};
  await db.set(`queue:${id}`,[item]);
 },{id:learnerId,text:legacyText});
 await student.reload();await poll(()=>student.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),'reload retains classroom');
 const legacy=await poll(async()=>(await works()).submissions.find(sub=>sub.id==='legacy-text-submission'),'old text queue uploaded');
 assert.equal(legacy.explanation,legacyText);assert.equal(legacy.selfAssessment,undefined);
 assert.equal((await current()).learner.id,learnerId);
 const list=await history(),historyText=await list.textContent();
 for(const goal of Object.values(goals))assert.match(historyText,goal);
 assert.ok(historyText.includes(legacyText),'old text appears in the same history as ratings');
 // Every rating keeps its own history article, including the two chapter 1 levels.
 for(const record of [chapter1First,chapter1Latest,chapter2,tea,fish,chapter4]){
  const matching=await list.locator('.history-item').allTextContents();
  assert.ok(matching.some(text=>text.includes(`第${record.chapterId}站`)&&goals[record.chapterId].test(text)&&new RegExp(`${record.selfAssessment.stars}\\s*[/／]\\s*3|${record.selfAssessment.stars}\\s*星`).test(text)),`history keeps chapter ${record.chapterId}: ${record.selfAssessment.stars} stars`);
 }
 await closeHistory();
 const allWorks=await works();assert.ok(allWorks.submissions.some(sub=>sub.source==='chapter'));
 assert.ok(allWorks.submissions.filter(sub=>sub.source==='chapter').every(sub=>!sub.selfAssessment),'automatic chapter archives never invent stars');
 checks.push('reload retains identity and all historical rating levels; old text-only queue uploads and stays readable; automatic chapter archives have no self-assessment');
 // Inspect per-chapter teacher data, then the separately rated chapter 3 tasks.
 await teacher.locator('[data-work-chapter="1"]').click();
 await teacher.locator('#learners .assessment-item[data-assessment-task=""] .assessment-stars[data-stars="3"]').waitFor();
 if(output){await teacher.locator('#learners tr').first().scrollIntoViewIfNeeded();await teacher.screenshot({path:join(output,'self-assessment-teacher-list.png'),fullPage:true});}
 await teacher.locator('#learners [data-view]').first().click();
 assert.match(await teacher.locator('.work-detail').textContent(),goals[1]);
 const chapter1Assessment=teacher.locator('.self-assessment-detail[data-assessment-chapter="1"]');
 await chapter1Assessment.locator('details.assessment-history summary').click();
 assert.equal(await chapter1Assessment.locator('li[data-assessment-id]').count(),2,'only the two student assessments count in history');
 for(const [record,stars] of [[chapter1First,1],[chapter1Latest,3]])await chapter1Assessment.locator(`li[data-assessment-id="${record.id}"] .assessment-stars[data-stars="${stars}"]`).waitFor();
 await teacher.locator('.detail-chapter').selectOption('2');
 await poll(()=>teacher.locator('.work-detail').textContent().then(text=>text.includes(legacyText)),'teacher retains old chapter 2 text');
 assert.match(await teacher.locator('.work-detail').textContent(),goals[2]);
 assert.equal(await teacher.locator('.self-assessment-detail[data-assessment-chapter="2"] .assessment-latest .assessment-stars[data-stars="2"]').count(),1,'later legacy text does not erase a chapter rating');
 await teacher.locator('#detail-dialog [data-close]').click();
 await teacher.locator('[data-work-chapter="3"]').click();
 for(const task of ['rice-roll','plant'])await teacher.locator(`#learners .assessment-item[data-assessment-task="${task}"] .assessment-unrated`).waitFor();
 for(const [task,stars] of [['tea',1],['fish',3]]){
  await teacher.locator('#task-filter').selectOption(task);
  await teacher.locator(`#learners .assessment-item[data-assessment-task="${task}"] .assessment-stars[data-stars="${stars}"]`).waitFor();
  await teacher.locator('#learners [data-view]').first().click();
  await poll(()=>teacher.locator('.work-detail').getAttribute('data-task').then(value=>value===task),`${task} detail`);
  const assessment=teacher.locator(`.self-assessment-detail[data-assessment-chapter="3"][data-assessment-task="${task}"]`);
  assert.match(await assessment.locator('.assessment-goal').textContent(),goals[3]);
  assert.equal(await assessment.locator(`.assessment-latest .assessment-stars[data-stars="${stars}"]`).count(),1);
  assert.equal(await assessment.locator(`.assessment-stars[data-stars="${stars===1?3:1}"]`).count(),0,'other task rating does not leak into detail');
  if(output){await teacher.locator('.world-preview canvas').waitFor();await teacher.waitForTimeout(200);await teacher.screenshot({path:join(output,`self-assessment-teacher-${task}.png`),fullPage:true});await assessment.screenshot({path:join(output,`self-assessment-teacher-${task}-rating.png`)});}
  await teacher.locator('#detail-dialog [data-close]').click();
 }
 checks.push('teacher shows latest chapter-specific rating and legacy text; chapter 3 table and detail isolate tea and fish ratings');
 if(output){await command('practice');await poll(()=>student.locator('#submitButton').isEnabled(),'screenshot practice');await openRating(2);await chooseStars(2);await student.screenshot({path:join(output,'self-assessment-tablet.png')});await student.locator('#submitDialog .dialog-close').tap();await history();await student.screenshot({path:join(output,'self-assessment-history.png')});}
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks,pageErrors:errors,ratings:studentSubs(await works()).map(sub=>({chapterId:sub.chapterId,taskId:sub.taskId,selfAssessment:sub.selfAssessment,legacy:!!sub.explanation})),screenshots:output},null,2));
}catch(error){if(output&&student)await student.screenshot({path:join(output,'self-assessment-failure.png')}).catch(()=>{});throw error;
}finally{await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});}
