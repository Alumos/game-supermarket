// Isolated renderer acceptance with real engine events and captured canvas pixels.
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
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-delivery-flags-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-flags-test'});
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
let browser;
const errors=[],checks=[];
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1100,height:900},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/delivery-flags-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Delivery renderer acceptance</title><style>body{margin:0;background:#243e41;display:grid;place-items:center;height:100vh}#world{width:696px;height:720px}</style><div id="world"></div>'}));
  await page.goto(origin+'/delivery-flags-test');
  await page.evaluate(async()=>{
    const {SupermarketWorld}=await import('/world.js');
    const engine=await import('/shared/engine.mjs');
    const world=new SupermarketWorld('#world');world.setChapter(4,'delivery');world.setMode('run');
    const best=engine.simulate(engine.exampleGraph(4,'delivery','best'));
    const bad=engine.simulate(engine.exampleGraph(4,'delivery','bad'));
    globalThis.fixture={world,engine,best,bad,events:best.trace.flatMap(step=>step.events)};
    globalThis.observe=()=>{
      const {world,engine}=fixture;world._draw();
      const pixel=(x,y)=>Array.from(world.g.getImageData(Math.round(x),Math.round(y),1,1).data).slice(0,3).join(',');
      const flags=Object.fromEntries(['A','B','C','D','E','F'].map(id=>{const p=world._xy(engine.DELIVERY_MAP.points[id]);return [id,pixel(p.x-35,p.y-34)];}));
      const p=world._xy(world.actor),pixels=world.g.getImageData(Math.round(p.x-35),Math.round(p.y-60),35,30).data;
      let backpackFlagPixels=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===201&&pixels[i+1]===108&&pixels[i+2]===76)backpackFlagPixels++;
      return {flags,backpackFlagPixels,labels:world.labels.map(label=>({text:label.s,x:label.x,y:label.y})),capture:world.capture(),orders:world.state.orders,anim:world.anim&&{elapsed:world.anim.elapsed,duration:world.anim.duration},actor:{...world.actor}};
    };
  });
  async function observe(){return page.evaluate(()=>observe());}
  async function screenshot(name){if(output){const {capture}=await observe();writeFileSync(join(output,name+'.png'),Buffer.from(capture.split(',')[1],'base64'));}}
  const red='201,108,76',grey='141,138,120';
  const initial=await observe();
  assert.deepEqual(Object.values(initial.flags),Array(6).fill(red));
  assert.equal(initial.backpackFlagPixels,0);
  assert.ok(initial.labels.some(label=>label.text==='❄ 28分钟内'));
  await screenshot('flags-start');checks.push('six roadside flags render with cold deadlines still visible');

  // Use a real successful event, leaving enough time to capture its transfer.
  await page.evaluate(()=>{
    const {world,events}=fixture,index=events.findIndex(event=>event.type==='delivery');
    world.setState(events[index-1].state);fixture.delivery=events[index];
    fixture.pending=world.playEvent(fixture.delivery,{speed:1});
  });
  await page.waitForFunction(()=>fixture.world.anim.elapsed/fixture.world.anim.duration>.72);
  await page.evaluate(()=>fixture.world.pause());
  const transfer=await observe();
  assert.notEqual(transfer.flags[await page.evaluate(()=>fixture.delivery.point)],red,'the delivered flag leaves its roadside position');
  assert.ok(transfer.backpackFlagPixels>0,'a pennant visibly flies towards the backpack');
  await screenshot('flags-transfer');
  await page.waitForTimeout(220);
  const frozen=await observe();assert.equal(frozen.anim.elapsed,transfer.anim.elapsed);assert.equal(frozen.capture,transfer.capture,'pause freezes the actual rendered flight');
  await page.evaluate(()=>fixture.world.resume());await page.evaluate(()=>fixture.pending);
  const delivered=await observe();
  assert.equal(Object.values(delivered.flags).filter(pixel=>pixel===red).length,5);
  assert.ok(delivered.backpackFlagPixels>0);
  assert.ok(delivered.labels.some(label=>label.text==='1'));
  await screenshot('flags-one-collected');checks.push('successful delivery transfers its flag at the state update; pause freezes it and resume collects it');

  // A stopped event reflects whichever authoritative state was already applied.
  await page.evaluate(()=>{const {world,events}=fixture;world.reset();const index=events.findIndex(event=>event.type==='delivery');world.setState(events[index-1].state);fixture.pending=world.playEvent(events[index],{speed:1});});
  await page.waitForFunction(()=>fixture.world.anim.elapsed/fixture.world.anim.duration>.72);
  await page.evaluate(()=>fixture.world.stop());
  const stopped=await observe();assert.equal(stopped.anim,null);assert.equal(Object.values(stopped.flags).filter(pixel=>pixel===red).length,5);assert.ok(stopped.labels.some(label=>label.text==='1'));
  await page.evaluate(()=>fixture.world.reset());
  assert.deepEqual(Object.values((await observe()).flags),Array(6).fill(red));checks.push('stopping a transfer keeps applied collection; reset restores every flag');

  await page.evaluate(async()=>{const {world,events}=fixture;for(const event of events)await world.playEvent(event,{speed:100});});
  const completed=await observe();assert.equal(Object.values(completed.flags).filter(pixel=>pixel===red).length,0);assert.equal(completed.orders.filter(order=>order.status==='delivered').length,6);assert.ok(completed.labels.some(label=>label.text==='6'));assert.ok(completed.backpackFlagPixels>0);
  await screenshot('flags-six-collected');checks.push('fast full engine playback collects all six flags on the courier');

  await page.evaluate(async()=>{const {world,bad}=fixture;world.reset();for(const event of bad.trace.flatMap(step=>step.events))await world.playEvent(event,{speed:100});});
  const failed=await observe();assert.equal(failed.flags.A,grey);assert.equal(failed.orders.find(order=>order.point==='A').status,'spoiled');assert.ok(failed.labels.some(label=>label.text==='5'));assert.ok(failed.labels.some(label=>label.text==='×'));assert.equal(Object.values(failed.flags).filter(pixel=>pixel===red).length,0);
  await screenshot('flags-spoiled');checks.push('a fully processed run keeps its spoiled flag and failure cross; courier only carries the five successes');

  // Teacher and restored views use the same state replacement path.
  await page.evaluate(()=>{const {world,best}=fixture;world.setMode('locked');world.setState(best.finalState);});
  const replay=await observe();assert.equal(Object.values(replay.flags).filter(pixel=>pixel===red).length,0);assert.ok(replay.labels.some(label=>label.text==='6'));
  await page.evaluate(()=>{const {world}=fixture;world.setChapter(2,'fresh-juice');world.setChapter(4,'delivery');});
  assert.deepEqual(Object.values((await observe()).flags),Array(6).fill(red));
  await page.evaluate(()=>{const {world,bad}=fixture;world.setState(bad.finalState);world.reset();});
  const reset=await observe();assert.deepEqual(Object.values(reset.flags),Array(6).fill(red));assert.equal(reset.backpackFlagPixels,0);
  checks.push('read-only final-state replay, chapter changes and repeated reset derive flags solely from orders');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{
  await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
  rmSync(dataDir,{recursive:true,force:true});
}
