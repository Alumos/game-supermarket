// Exercise the real demonstration button and observe text actually drawn to canvas.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createClassroomServer} from '../server.mjs';
import {TASKS,actionLabel,exampleGraph,simulate} from '../shared/engine.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
  try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Playwright is required.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-narration-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-narration'});
const errors=[],checks=[];
let browser;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  if(process.env.SUPERMARKET_TEST_OUTPUT){
    const output=resolve(process.env.SUPERMARKET_TEST_OUTPUT);mkdirSync(output,{recursive:true});
    await page.exposeFunction('__saveNarrationFrame',name=>page.screenshot({path:join(output,`${name}.png`),fullPage:true}));
  }
  await page.goto(origin+'/');
  await page.waitForFunction(()=>!document.querySelector('#connection').textContent.includes('正在连接'));
  if(await page.locator('#welcome').isVisible())await page.locator('#practiceButton').click();
  await page.waitForFunction(()=>!document.querySelector('#runButton').disabled);
  await page.evaluate(async()=>{
    const {SupermarketWorld}=await import('/world.js');
    const prototype=SupermarketWorld.prototype,play=prototype.playEvent,draw=prototype._draw;
    window.__narrationEvents=[];window.__narrationSpeed=100;
    prototype.playEvent=function(event,options){
      const promise=play.call(this,event,{...options,speed:window.__narrationSpeed});
      const entry={event:structuredClone(event),dialogue:document.querySelector('#dialogueText').textContent,flash:event.type==='walk'?null:this.flash?.text,rendered:[],after:null};
      this.__narrationEntry=entry;window.__narrationEvents.push(entry);
      return promise.then(result=>{entry.after=structuredClone(this.state);return result;});
    };
    prototype._draw=function(){
      draw.call(this);
      const entry=this.__narrationEntry;
      if(this.anim&&entry)for(const {s} of this.labels)if(!entry.rendered.includes(s))entry.rendered.push(s);
      if(window.__saveNarrationFrame&&this.anim&&this.anim.elapsed>=this.anim.duration*.7&&!entry.captured&&['tea:steep','tea:lid','fresh-juice:start_juicer'].includes(`${this.taskId}:${entry.event.actionId}`)){
        entry.captured=true;this.pause();
        window.__saveNarrationFrame(`${this.taskId}-${entry.event.actionId}`).then(()=>this.resume());
      }
    };
  });
  async function records(prefix){return page.evaluate(async prefix=>(await import('/db.js')).all(prefix),prefix);}
  async function stored(key){return page.evaluate(async key=>(await import('/db.js')).get(key),key);}
  async function drag(action){
    await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));
    const source=page.locator(`[data-action="${action}"]`),cards=page.locator('#flowNodes .flow-node');
    const end=await cards.count()?cards.last():page.locator('#flowScroll');
    const count=await page.locator('#flowNodes .flow-node').count();
    await source.scrollIntoViewIfNeeded();await end.scrollIntoViewIfNeeded();
    const a=await source.boundingBox(),b=await end.boundingBox();assert.ok(a&&b);
    await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:14});await page.mouse.up();
    await page.waitForFunction(count=>document.querySelectorAll('#flowNodes .flow-node').length===count,count+1);
  }
  async function choose(task){
    const chapter=page.locator(`#chapters [data-chapter="${task.chapterId}"]`);
    if(!(await chapter.getAttribute('class')).includes('active'))await chapter.click();
    if(task.chapterId===3)await page.locator(`[data-practice-task="${task.id}"]`).click();
    await page.waitForFunction(()=>!document.querySelector('#submitButton').disabled);
    if(task.chapterId===3)assert.equal(await page.locator(`[data-practice-task="${task.id}"]`).getAttribute('aria-pressed'),'true');
  }
  for(const task of TASKS.filter(task=>task.chapterId<4)){
    await choose(task);
    for(const action of task.actions)assert.equal((await page.locator(`[data-action="${action.actionId}"]`).textContent()).replace(/^＋\s*/,''),action.label,`${task.id} operation card`);
    await drag(task.actions[0].actionId);
    if(await page.locator('#nodeLabel').isVisible()){
      await page.locator('#nodeLabel').fill(`我的${task.name}草稿`);await page.locator('#nodeLabel').blur();
    }
    const draftKey=`draft:practice:${task.chapterId}:${task.id}`;
    await page.waitForFunction(async key=>(await import('/db.js')).get(key).then(value=>value?.graph.nodes.length===3),draftKey);
    const before=await stored(draftKey),visible=await page.locator('#flowNodes').textContent(),runs=await records('run:'),submissions=await records('submission:');
    await page.evaluate(()=>{window.__narrationEvents=[];});
    await page.locator('#demoButton').click();
    await page.waitForFunction(()=>document.querySelector('#dialogueText').textContent.startsWith('示范结束了。'),null,{timeout:60000});
    const observed=await page.evaluate(()=>window.__narrationEvents),result=simulate(exampleGraph(task.chapterId,task.id));
    const physical=observed.filter(entry=>entry.event.type!=='walk');
    const expected=result.trace.flatMap(step=>step.events.filter(event=>event.type!=='walk').map(event=>({event,step})));
    assert.deepEqual(physical.map(entry=>[entry.event.type,entry.event.actionId]),expected.map(({event})=>[event.type,event.actionId]),`${task.id} executes the full physical demonstration`);
    for(const [index,entry] of physical.entries()){
      const {event,step}=expected[index];
      assert.ok(entry.dialogue.includes(actionLabel(step)),`${task.id}: dialogue explains ${actionLabel(step)}`);
      const expectedText=event.type==='action'?actionLabel(event):entry.flash;
      assert.equal(entry.flash,expectedText,`${task.id}/${event.actionId}: map matches card`);
      assert.ok(entry.rendered.includes(expectedText),`${task.id}/${event.actionId}: narration reaches the rendered map`);
      if(event.type==='action')assert.deepEqual(entry.after.flags,event.state.flags,`${task.id}/${event.actionId}: map state follows this operation`);
    }
    if(task.id==='fresh-juice'){
      for(const entry of physical)for(const action of task.actions)assert.ok(entry.rendered.join('').includes(action.label),`juice progress strip renders canonical label ${action.label}`);
    }
    if(task.id==='tea'){
      assert.deepEqual(physical.map(entry=>entry.flash),['取杯放茶包','注入规定量适温水','等待浸泡（快进）','取出茶包','加盖贴签']);
      assert.doesNotMatch(physical[2].flash,/放入茶包/);
    }
    assert.deepEqual((await stored(draftKey)).graph,before.graph,`${task.id}: completed demonstration preserves the user's draft`);
    assert.equal(await page.locator('#flowNodes').textContent(),visible);
    assert.deepEqual(await records('run:'),runs);assert.deepEqual(await records('submission:'),submissions);
    checks.push(`${task.id}: palette, dialogue and rendered map agree throughout the real demonstration; draft remains intact`);
  }
  await choose(TASKS.find(task=>task.id==='tea'));
  const beforeStop=await stored('draft:practice:3:tea'),runs=await records('run:');
  await page.evaluate(()=>{window.__narrationEvents=[];window.__narrationSpeed=1;});
  await page.locator('#demoButton').click();
  await page.waitForFunction(()=>window.__narrationEvents.some(entry=>entry.event.actionId==='cup'&&entry.event.type==='action'),null,{timeout:30000});
  await page.locator('#pauseButton').click();await page.locator('#stopButton').click();
  await page.waitForFunction(()=>!document.querySelector('#runButton').disabled);
  assert.deepEqual((await stored('draft:practice:3:tea')).graph,beforeStop.graph);
  assert.deepEqual(await records('run:'),runs,'stopping a demonstration creates no student run');
  assert.deepEqual(await page.locator('#flowNodes .flow-node').evaluateAll(nodes=>nodes.map(node=>node.dataset.node)),beforeStop.graph.nodes.map(node=>node.id));
  checks.push('pausing and stopping tea demonstration preserves the original draft and creates no run');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{
  await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});
}
