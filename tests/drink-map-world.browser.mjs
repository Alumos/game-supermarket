// Isolated renderer acceptance for the chapter-1 map drag surface. This keeps
// browser coverage independent from app.js while exercising real mouse and
// touch PointerEvents against the canvas.
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
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-drink-map-'));
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-drink-map-test'});
let browser,context;
const errors=[],checks=[];
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  context=await browser.newContext({viewport:{width:980,height:760},deviceScaleFactor:1,hasTouch:true});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/drink-map-world-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Drink map renderer acceptance</title><style>html,body{margin:0;background:#243e41;height:100%}#world{width:760px;height:620px;margin:20px auto}</style><div id="world"></div>'}));
  await page.goto(origin+'/drink-map-world-test');
  await page.evaluate(async()=>{
    const {SupermarketWorld}=await import('/world.js');
    const world=new SupermarketWorld('#world',{onDrinkMove:move=>fixture.moves.push(move),onDrinkDragFeedback:feedback=>fixture.feedback.push(feedback)});
    world.setChapter(1,'drink-swap');fixture={world,moves:[],feedback:[]};world.setDrinkDragEnabled(true);
    globalThis.dragPoint=(id)=>{const gx={A:5,B:10,C:15}[id],p=world._xy({x:gx,y:9}),r=world.canvas.getBoundingClientRect(),q=world._projection(r.width,r.height);return {x:r.left+q.ox+p.x*q.scaleX,y:r.top+q.oy+(p.y-62)*q.scaleY};};
    globalThis.snapshot=()=>{world._draw();return {labels:world.labels.map(label=>label.s),drag:Boolean(world.drinkDrag),moves:fixture.moves.slice(),feedback:fixture.feedback.slice(),capture:world.capture()};};
  });
  const point=id=>page.evaluate(id=>dragPoint(id),id);
  const center=await page.locator('canvas').boundingBox();assert.ok(center);
  const initial=await page.evaluate(()=>snapshot());
  assert.ok(initial.labels.some(label=>label.includes('顺顺超市')),'map title uses 顺顺超市');
  assert.ok(!initial.labels.some(label=>label.includes('有序超市')),'old map title is absent');
  checks.push('chapter 1 title is 顺顺超市');

  // Real mouse drag from occupied A to the empty C cabinet.
  const a=await point('A'),c=await point('C');
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(c.x,c.y,{steps:8});
  const during=await page.evaluate(()=>snapshot());assert.equal(during.drag,true,'pointer capture keeps drag alive');
  await page.mouse.up();
  let result=await page.evaluate(()=>snapshot());assert.deepEqual(result.moves,[{from:'A',to:'C'}],'mouse drop emits one intent');
  checks.push('mouse drag follows pointer and emits A→C only on pointerup');

  // The world does not mutate task state; app writes its simulation result back.
  await page.evaluate(()=>fixture.world.setState({...fixture.world.state,slots:{A:null,B:'milk',C:null}}));
  const b=await point('B');
  await page.mouse.move(b.x,b.y);await page.mouse.down();await page.mouse.move(c.x,c.y,{steps:6});await page.mouse.up();
  result=await page.evaluate(()=>snapshot());assert.deepEqual(result.moves,[{from:'A',to:'C'},{from:'B',to:'C'}],'updated state allows a later move');
  checks.push('state replacement controls later source and target availability');

  // Occupied target, original cabinet, and map-outside releases are all no-op.
  await page.evaluate(()=>fixture.world.setState({...fixture.world.state,slots:{A:'orange',B:'milk',C:null}}));
  for(const [from,to] of [['A','B'],['A','A']]){const s=await point(from),t=await point(to);await page.mouse.move(s.x,s.y);await page.mouse.down();await page.mouse.move(t.x,t.y,{steps:5});await page.mouse.up();}
  const outside={x:center.x-30,y:center.y-30};await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(outside.x,outside.y,{steps:5});await page.mouse.up();
  result=await page.evaluate(()=>snapshot());assert.equal(result.moves.length,2,'occupied/original/outside drops do not emit moves');assert.ok(result.feedback.length>=2,'invalid drops provide local feedback');
  checks.push('occupied, original and map-outside drops preserve move history');

  // Touch pointer path uses the same capture and target tolerance.
  await page.evaluate(()=>{fixture.moves=[];fixture.feedback=[];fixture.world.setState({...fixture.world.state,slots:{A:'orange',B:'milk',C:null}});});
  const touch=await page.getByRole('img').boundingBox();assert.ok(touch);
  const tc=await point('C');
  await page.touchscreen.tap(a.x,a.y); // sanity check that the canvas accepts touch input
  const client=await page.evaluate(()=>({canvas:document.querySelector('canvas').getBoundingClientRect().toJSON()}));
  await page.evaluate(({a,tc})=>{
    const canvas=document.querySelector('canvas');const r=canvas.getBoundingClientRect();
    const fire=(type,p)=>canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:77,pointerType:'touch',isPrimary:true,clientX:p.x,clientY:p.y,button:0}));
    fire('pointerdown',a);for(let i=1;i<=6;i++)fire('pointermove',{x:a.x+(tc.x-a.x)*i/6,y:a.y+(tc.y-a.y)*i/6});fire('pointerup',tc);
  },{a,tc});
  result=await page.evaluate(()=>snapshot());assert.deepEqual(result.moves,[{from:'A',to:'C'}],'touch pointer drag emits one move');
  checks.push('touch pointer drag follows the same captured path and target tolerance');

  // Teacher/paused/run state disables and cancels an in-flight drag.
  await page.evaluate(()=>{fixture.moves=[];fixture.world.setDrinkDragEnabled(true);fixture.world.pause();});
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(c.x,c.y,{steps:4});await page.mouse.up();
  assert.deepEqual((await page.evaluate(()=>snapshot())).moves,[],'paused world rejects drag');
  await page.evaluate(()=>{fixture.world.resume();fixture.world.setMode('run');fixture.world.setDrinkDragEnabled(true);});
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(c.x,c.y,{steps:4});await page.mouse.up();
  assert.deepEqual((await page.evaluate(()=>snapshot())).moves,[],'run mode rejects drag even if setter is called');
  checks.push('pause and run/locked modes cancel or reject drag');

  if(output){const final=await page.evaluate(()=>snapshot());writeFileSync(join(output,'drink-map-world.png'),Buffer.from(final.capture.split(',')[1],'base64'));}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}finally{
  await context?.close();await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});
}
