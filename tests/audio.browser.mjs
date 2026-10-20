// Native Web Audio acceptance; all playback and editing use real pointer/tap controls.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClassroomServer} from '../server.mjs';
import {TASKS} from '../shared/engine.mjs';

let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)){
  try{playwright=await import(location);break;}catch{}
}
if(!playwright)throw new Error('Playwright is required.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-audio-browser-'));
const teacherKey='isolated-audio-acceptance';
const {server}=createClassroomServer({dataDir,teacherKey});
const errors=[],checks=[];
let browser;

// Observe real nodes and their real output routes; do not replace their sound generation.
function observeNativeAudio(){
  const Native=window.AudioContext||window.webkitAudioContext;
  const contexts=[],sources=[],routes=new Map();
  let starts=0;
  function track(node){
    const edges=new Set();routes.set(node,edges);
    const connect=node.connect.bind(node),disconnect=node.disconnect.bind(node);
    node.connect=function(target,...args){const result=connect(target,...args);edges.add(target);return result;};
    node.disconnect=function(...args){const result=disconnect(...args);if(!args.length)edges.clear();else edges.delete(args[0]);return result;};
    return node;
  }
  function hasOutput(node,seen=new Set()){
    if(!node||seen.has(node))return false;
    seen.add(node);
    if(node===node.context.destination)return true;
    if(node.gain&&node.gain.value<=.00001)return false;
    return [...(routes.get(node)||[])].some(target=>hasOutput(target,new Set(seen)));
  }
  if(Native){
    const Observed=new Proxy(Native,{construct(Target,args){
      const context=Reflect.construct(Target,args);contexts.push(context);
      const gain=context.createGain.bind(context),filter=context.createBiquadFilter.bind(context);
      context.createGain=(...args)=>track(gain(...args));
      context.createBiquadFilter=(...args)=>track(filter(...args));
      for(const factory of ['createOscillator','createBufferSource']){
        const create=context[factory].bind(context);
        context[factory]=(...args)=>{
          const node=track(create(...args)),entry={node,started:false,startAt:0,stopAt:Infinity,ended:false};sources.push(entry);
          const start=node.start.bind(node),stop=node.stop.bind(node);
          node.start=function(when=0){const result=start(when);entry.started=true;entry.startAt=when;starts++;return result;};
          node.stop=function(when=0){const result=stop(when);entry.stopAt=Math.min(entry.stopAt,when);return result;};
          node.addEventListener('ended',()=>{entry.ended=true;});
          return node;
        };
      }
      return context;
    }});
    window.AudioContext=Observed;if(window.webkitAudioContext)window.webkitAudioContext=Observed;
  }
  window.__nativeAudio={snapshot(){
    const live=sources.filter(entry=>entry.started&&!entry.ended&&entry.node.context.currentTime>=entry.startAt&&entry.node.context.currentTime<entry.stopAt);
    return {contexts:contexts.length,states:contexts.map(context=>context.state),starts,live:live.length,audible:live.filter(entry=>entry.node.context.state==='running'&&hasOutput(entry.node)).length};
  }};
}

try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
  await context.addInitScript(observeNativeAudio);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const native=()=>page.evaluate(()=>window.__nativeAudio.snapshot());
  async function ready(){
    await page.waitForFunction(()=>!document.querySelector('#connection').textContent.includes('正在连接'));
    if(await page.locator('#welcome').isVisible())await page.locator('#practiceButton').tap();
    await page.waitForFunction(()=>!document.querySelector('#demoButton').disabled);
    await page.locator('#transition').waitFor({state:'hidden'});
  }
  async function observeGame(){
    await page.evaluate(async()=>{
      const {gameAudio}=await import('/audio.js');window.__audioCalls=[];window.__audioWorld=null;
      for(const method of ['step','result','startEvent','advanceEvent','pauseEvent','resumeEvent','stopEvent']){
        const original=gameAudio[method];
        if(typeof original!=='function')throw new Error(`Missing gameAudio.${method}`);
        gameAudio[method]=function(...args){
          if(method==='startEvent')window.__audioWorld=args[0];
          const entry={method,kind:method==='startEvent'?args[1]?.type:args[0],actionId:method==='startEvent'?args[1]?.actionId:null,time:performance.now()};
          if(method!=='advanceEvent')window.__audioCalls.push(entry);
          const before=method==='result'?window.__nativeAudio.snapshot().starts:0;
          const result=original.apply(this,args);
          if(method==='result')entry.sources=window.__nativeAudio.snapshot().starts-before;
          return result;
        };
      }
    });
  }
  async function drag(action){
    await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));
    const source=page.locator(`[data-action="${action}"]`),end=page.locator('#flowNodes .flow-node').last(),before=await page.locator('#flowNodes .flow-node').count();
    await source.scrollIntoViewIfNeeded();await end.scrollIntoViewIfNeeded();
    const a=await source.boundingBox(),b=await end.boundingBox();assert.ok(a&&b);
    await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:14});await page.mouse.up();
    await page.waitForFunction(count=>document.querySelectorAll('#flowNodes .flow-node').length===count,before+1);
  }

  await page.goto(origin+'/');await page.locator('#soundButton').waitFor();
  await page.waitForTimeout(250);
  assert.deepEqual(await native(),{contexts:0,states:[],starts:0,live:0,audible:0},'loading the page never creates an AudioContext or autoplays sound');
  assert.equal((await page.locator('#soundButton').textContent()).trim(),'音效：开');
  await observeGame();await ready();
  checks.push('student page loads with a compact enabled sound control and no pregesture AudioContext or autoplay');

  // Use the actual demonstration, then mute its running animation with a touch tap.
  await page.locator('#chapters [data-chapter="2"]').click();await ready();
  const draft=await page.evaluate(async()=>(await import('/db.js')).get('draft:practice:2:fresh-juice'));
  const beforeRuns=await page.evaluate(async()=>(await import('/db.js')).all('run:'));
  await page.locator('#demoButton').tap();
  await page.waitForFunction(()=>window.__nativeAudio.snapshot().audible>0);
  assert.equal((await native()).contexts,1,'one shared native context handles gesture playback');
  assert.ok((await native()).states.includes('running'));
  await page.waitForFunction(()=>window.__audioWorld?.anim&&window.__nativeAudio.snapshot().audible>0);
  await page.locator('#soundButton').tap();
  assert.equal((await page.locator('#soundButton').textContent()).trim(),'音效：关');
  await page.waitForFunction(()=>window.__nativeAudio.snapshot().audible===0);
  assert.equal(await page.locator('#runButton').isDisabled(),true,'muting leaves the demonstration running');
  assert.equal(await page.locator('#stopButton').isEnabled(),true);
  const muted=await native(),progress=await page.evaluate(()=>window.__audioWorld?.time);
  await page.waitForTimeout(400);
  assert.equal((await native()).starts,muted.starts,'muting prevents subsequent animation sound sources');
  assert.ok(await page.evaluate(previous=>window.__audioWorld.time>previous,progress),'animation time continues while muted');
  assert.deepEqual(await page.evaluate(async()=>(await import('/db.js')).get('draft:practice:2:fresh-juice')),draft,'sound control preserves the draft');
  checks.push('real touch demonstration unlocks one native context; muting silences output and future tones while gameplay continues');

  await page.locator('#stopButton').click();await ready();
  await page.reload();await ready();
  assert.equal((await page.locator('#soundButton').textContent()).trim(),'音效：关','mute preference survives reload');
  assert.equal((await native()).starts,0,'muted reload creates no sound');
  await observeGame();await page.locator('#soundButton').tap();
  await page.locator('#demoButton').click();
  await page.waitForFunction(()=>window.__audioWorld?.anim&&window.__nativeAudio.snapshot().audible>0);
  await page.locator('#pauseButton').tap();
  await page.waitForFunction(()=>window.__audioWorld?.paused&&window.__nativeAudio.snapshot().audible===0);
  const paused=await native(),pausedTime=await page.evaluate(()=>window.__audioWorld.time);
  await page.waitForTimeout(450);
  assert.equal((await native()).starts,paused.starts,'paused animation schedules no new sounds');
  assert.equal(await page.evaluate(()=>window.__audioWorld.time),pausedTime,'pause also freezes actual animation time');
  await page.locator('#pauseButton').tap();
  await page.waitForFunction(count=>window.__nativeAudio.snapshot().starts>count,paused.starts);
  await page.locator('#stopButton').tap();await ready();
  await page.waitForFunction(()=>window.__nativeAudio.snapshot().audible===0);
  const stopped=await native();await page.waitForTimeout(400);
  assert.equal((await native()).starts,stopped.starts,'stop leaves no animation sound scheduler');
  assert.equal(await page.evaluate(()=>window.__audioWorld.anim),null);
  assert.deepEqual(await page.evaluate(async()=>{const {gameAudio}=await import('/audio.js');return {voices:gameAudio.voices.size,events:gameAudio.events.size};}),{voices:0,events:0},'stop removes all voice and event owners');
  assert.deepEqual(await page.evaluate(async()=>(await import('/db.js')).all('run:')),beforeRuns,'demo controls create no student run');
  checks.push('mute persists after reload; pointer/tap pause, resume and stop freeze, restart and clean up animation audio');

  // Build a valid student flow with actual drags and run it through the real engine.
  await page.locator('#chapters [data-chapter="3"]').click();await ready();
  await page.locator('[data-practice-task="tea"]').click();await ready();
  for(const action of TASKS.find(task=>task.id==='tea').actions)await drag(action.actionId);
  await page.locator('#chainButton').click();
  await page.evaluate(()=>{window.__audioCalls=[];});
  const beforeValidRun=await native();await page.locator('#runButton').tap();
  await page.waitForFunction(()=>!document.querySelector('#result').hidden&&document.querySelector('#result').textContent.includes('任务完成'),null,{timeout:30000});
  await ready();
  const calls=await page.evaluate(()=>window.__audioCalls.map(({method,kind,actionId,sources})=>({method,kind:typeof kind==='object'?null:kind,actionId,sources})));
  assert.ok(calls.some(call=>call.method==='step'&&call.kind==='start'),'real student playback sounds its start node');
  assert.ok(calls.some(call=>call.method==='step'&&call.kind==='end'),'real student playback sounds its end node');
  assert.ok(calls.filter(call=>call.method==='step').length>=7,'all five operation steps generate flow feedback');
  assert.ok(calls.some(call=>call.method==='result'&&call.kind===true&&call.sources>=2),'successful student run plays native completion tones');
  assert.ok(calls.some(call=>call.method==='startEvent'&&call.actionId==='steep'),'real tea animation reaches the long physical action');
  assert.ok((await native()).starts>beforeValidRun.starts,'student playback creates native sound sources');
  assert.equal((await native()).contexts,1,'all scenes continue sharing one context');
  checks.push('a valid student tea flow built by real drags emits start/action/end and success feedback using native oscillators');

  await page.waitForFunction(async()=>!!navigator.serviceWorker.controller&&!!(await caches.match('/audio.js')));
  await context.setOffline(true);
  try{
    await page.reload();await ready();
    assert.equal((await native()).contexts,0,'offline reload also waits for a gesture');
    await page.locator('#demoButton').tap();
    await page.waitForFunction(()=>window.__nativeAudio.snapshot().audible>0);
    await page.locator('#stopButton').tap();await ready();
  }finally{await context.setOffline(false);}
  checks.push('service worker caches audio.js; a full offline reload still starts native demonstration audio from a real touch');

  // Teacher uses the same persistent preference and a real, reachable control.
  await page.locator('#soundButton').tap();
  const login=await context.request.post(origin+'/api/teacher/login',{data:{key:teacherKey}});assert.equal(login.status(),200);
  const teacher=await context.newPage();teacher.on('pageerror',error=>errors.push(error.message));
  await teacher.goto(origin+'/teacher.html');await teacher.locator('#soundButton').waitFor();
  assert.equal((await teacher.locator('#soundButton').textContent()).trim(),'音效：关');
  assert.equal(await teacher.evaluate(()=>window.__nativeAudio.snapshot().starts),0);
  await teacher.locator('#soundButton').tap();
  assert.equal((await teacher.locator('#soundButton').textContent()).trim(),'音效：开');
  await teacher.reload();await teacher.locator('#soundButton').waitFor();
  assert.equal((await teacher.locator('#soundButton').textContent()).trim(),'音效：开');
  assert.equal(await teacher.evaluate(()=>window.__nativeAudio.snapshot().contexts),0,'teacher reload does not autoplay');
  checks.push('teacher sound button reads the shared preference, accepts touch, persists changes and never autoplays');

  const unsupported=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
  await unsupported.addInitScript(()=>{window.AudioContext=undefined;window.webkitAudioContext=undefined;});
  const fallback=await unsupported.newPage();fallback.on('pageerror',error=>errors.push(error.message));
  await fallback.goto(origin+'/');
  await fallback.waitForFunction(()=>!document.querySelector('#connection').textContent.includes('正在连接'));
  if(await fallback.locator('#welcome').isVisible())await fallback.locator('#practiceButton').tap();
  await fallback.waitForFunction(()=>!document.querySelector('#demoButton').disabled);
  await fallback.locator('#soundButton').tap();await fallback.locator('#soundButton').tap();
  await fallback.locator('#demoButton').tap();
  await fallback.waitForFunction(()=>!document.querySelector('#stopButton').disabled);
  assert.equal(await fallback.evaluate(async()=>{const {gameAudio}=await import('/audio.js');return gameAudio.supported;}),false);
  await fallback.locator('#stopButton').tap();
  await fallback.waitForFunction(()=>!document.querySelector('#demoButton').disabled);
  checks.push('without AudioContext, sound toggles and real demonstration controls remain usable without page errors');
  await unsupported.close();

  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{
  await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});
}
