// Independent student advancement, teacher overrides and offline queue replay.
// Every record is created in a temporary directory and removed after the run.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClassroomServer} from '../server.mjs';
let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Playwright is required.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-progression-'));
const {server}=createClassroomServer({dataDir,teacherKey:'progression-browser'});
const errors=[],checks=[];let browser;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
 const teacherContext=await browser.newContext(),one=await browser.newContext(),two=await browser.newContext();
 for(const context of [one,two])await context.addInitScript(()=>{const Native=window.EventSource;window.__progressStreams=[];window.EventSource=class extends Native{constructor(...args){super(...args);window.__progressStreams.push(this);}};});
 const teacher=await teacherContext.newPage(),first=await one.newPage(),second=await two.newPage();
 for(const page of [teacher,first,second])page.on('pageerror',e=>errors.push(e.message));
 async function api(context,path,body){const response=await context.request.fetch(origin+path,{method:body?'POST':'GET',data:body}),data=await response.json();assert.ok(response.ok(),JSON.stringify(data));return data;}
 async function poll(fn,label,timeout=30000){const until=Date.now()+timeout;while(Date.now()<until){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out: '+label);}
 await api(teacherContext,'/api/teacher/login',{key:'progression-browser'});
 let {session}=await api(teacherContext,'/api/sessions',{name:'个人推进浏览器验收'});
 const room=context=>api(context,`/api/sessions/${session.id}/state`);
 const works=()=>api(teacherContext,`/api/sessions/${session.id}/works`);
 async function command(action,extra={}){const latest=await room(teacherContext);const result=await api(teacherContext,`/api/sessions/${session.id}/commands`,{commandId:crypto.randomUUID(),expectedVersion:latest.session.version,action,...extra});session=result.session;return result;}
 async function at(page,ch,enabled=true){await poll(async()=>await page.locator('#chapterNumber').textContent().then(t=>t.endsWith(`0${ch}`))&&await page.locator('#submitButton').isEnabled()===enabled,`station ${ch} ${enabled?'editable':'locked'}`);}
 async function rate(page,stars=3){await page.locator('#submitButton').click();await page.locator(`#selfRatingGroup label:has(input[value="${stars}"])`).click();await page.locator('#submitForm [type=submit]').click();await page.locator('#submitDialog').waitFor({state:'hidden'});}
 async function queueEmpty(page,id){await poll(()=>page.evaluate(async id=>(await (await import('/db.js')).get(`queue:${id}`,[])).length===0,id),'queue drained');}
 async function offline(context,page){await context.setOffline(true);await page.evaluate(()=>window.__progressStreams.forEach(stream=>stream.close()));await poll(()=>page.locator('#connection').textContent().then(t=>t.includes('离线')),'offline indicator');}
 await teacher.goto(origin+'/teacher.html');await first.goto(origin+'/');await second.goto(origin+'/');
 await poll(()=>first.locator('#accountButton').textContent().then(t=>/^A\d+$/.test(t)),'first student joins');await poll(()=>second.locator('#accountButton').textContent().then(t=>/^A\d+$/.test(t)),'second student joins');
 const id1=(await api(one,'/api/me')).learner.id,id2=(await api(two,'/api/me')).learner.id;assert.notEqual(id1,id2);
 await command('chapter',{chapterId:1});await at(first,1);await at(second,1);
 const oldSnapshot=await room(one);await rate(first);await at(first,2);await poll(async()=>(await room(one)).session.chapterId===2,'first authority advances');await at(second,1);
 await first.evaluate(data=>window.__progressStreams.at(-1).dispatchEvent(new MessageEvent('state',{data:JSON.stringify(data)})),oldSnapshot);await at(first,2);
 await poll(()=>teacher.locator(`[data-learner-row="${id1}"]`).textContent().then(t=>t.includes('已进入第 2 章')),'teacher recognizes the progressed student');assert.doesNotMatch(await teacher.locator(`[data-learner-row="${id1}"]`).textContent(),/等待进入/);await poll(()=>teacher.locator('#stat-ack').textContent().then(t=>t==='2 人已进入 · 0 人待进入'),'both personal chapters count as acknowledged');
 assert.equal((await room(teacherContext)).session.chapterId,1);assert.equal((await room(two)).session.chapterId,1);
 await first.reload();await at(first,2);await at(second,1);checks.push('one student advances alone and reload retains progress');
 for(const [ch,stars] of [[2,1],[3,2],[4,3]]){await at(first,ch);await rate(first,stars);await at(first,Math.min(ch+1,4));}
 await queueEmpty(first,id1);const initial=(await works()).submissions.filter(s=>s.learnerId===id1&&s.source==='student');
 assert.deepEqual(initial.map(s=>s.chapterId).sort(),[1,2,3,4]);assert.deepEqual(initial.map(s=>s.selfAssessment.stars),[3,1,2,3]);for(const sub of initial)assert.equal(sub.graph.chapterId,sub.chapterId);
 assert.equal((await room(one)).session.chapterId,4);await at(second,1);checks.push('all three rating choices advance; fourth station saves without a fifth station');
 for(const card of await first.locator('#coordinateCards button').all()){const point=await card.getAttribute('data-coordinate'),x=await card.getAttribute('data-x'),y=await card.getAttribute('data-y');assert.equal(await card.textContent(),`移动至 ${point}（${x},${y}）`);}
 await command('chapter',{chapterId:3});await at(first,3);await at(second,3);await command('pause');await at(first,3,false);await at(second,3,false);
 await teacher.locator('#next').click();await at(first,4);await at(second,4);assert.equal((await room(teacherContext)).session.phase,'practice');assert.equal(await teacher.locator('#next').isDisabled(),true);checks.push('teacher chapter and next immediately open editing; pause locks both students');
 await command('chapter',{chapterId:1});await at(first,1);await at(second,1);await queueEmpty(first,id1);
 await offline(one,first);await rate(first,1);await at(first,2);await rate(first,2);await at(first,3);
 await first.reload();await at(first,3);assert.match(await first.locator('#connection').textContent(),/离线/);
 assert.equal((await first.evaluate(async id=>(await (await import('/db.js')).get(`progression:${id}`)),id1))?.chapterId,3,'offline refresh retains unconfirmed progression');
 const queuedWrite=url=>/^\/api\/student\/(?:drafts|runs|submissions)(?:\/|$)/.test(url.pathname),blockWrite=route=>route.abort();await one.route(queuedWrite,blockWrite);await one.setOffline(false);await first.reload();await at(first,3);
 assert.equal((await first.evaluate(async id=>(await (await import('/db.js')).get(`progression:${id}`)),id1))?.chapterId,3,'an online refresh preserves progression until queued ratings reach the server');
 await one.unroute(queuedWrite,blockWrite);await first.evaluate(()=>window.dispatchEvent(new Event('online')));await poll(async()=>(await room(one)).session.chapterId===3,'offline submissions unlock server sequentially');await queueEmpty(first,id1);await at(first,3);await at(second,1);
 const replay=(await works()).submissions.filter(s=>s.learnerId===id1&&s.source==='student');assert.equal(replay.length,6);assert.equal(replay.filter(s=>s.offline).length,2);checks.push('offline ratings advance immediately, survive reload and replay in order');
 await offline(one,first);await rate(first);await at(first,4);await command('chapter',{chapterId:2});await at(second,2);await one.setOffline(false);await at(first,2);await queueEmpty(first,id1);
 assert.equal((await room(one)).session.chapterId,2);assert.equal((await works()).submissions.filter(s=>s.learnerId===id1&&s.source==='student').length,7);checks.push('teacher epoch overrides pending offline advancement without losing the rating');
 await command('pause');await at(first,2,false);await first.reload();await at(first,2,false);await command('resume');await at(first,2);checks.push('pause remains locked after refresh');
 await command('chapter',{chapterId:1});await at(first,1);await queueEmpty(first,id1);const beforeReset=(await works()).submissions.filter(s=>s.learnerId===id1&&s.source==='student').length;
 await offline(one,first);await rate(first,1);await at(first,2);await rate(first,2);await at(first,3);teacher.once('dialog',dialog=>dialog.accept());await teacher.locator('#chapters [data-chapter="1"]').click();await at(second,1);await one.setOffline(false);await at(first,1);await queueEmpty(first,id1);
 const afterReset=(await works()).submissions.filter(s=>s.learnerId===id1&&s.source==='student');assert.equal(afterReset.length,beforeReset+2);assert.deepEqual(afterReset.slice(-2).map(s=>s.chapterId),[1,2]);assert.equal((await room(one)).session.chapterId,1);checks.push('teacher reset preserves every station of a continuous offline submission chain');
 await command('end');const localContext=await browser.newContext(),local=await localContext.newPage();local.on('pageerror',e=>errors.push(e.message));await local.goto(origin+'/');await local.locator('#practiceButton').click();
 for(const ch of [1,2,3,4]){await at(local,ch);await rate(local);await at(local,Math.min(ch+1,4));}
 await local.reload();await at(local,4);assert.equal((await api(localContext,'/api/me')).learner,undefined);checks.push('local experience advances through four stations and retains the final station');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});}
