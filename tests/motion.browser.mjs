// Real-pointer acceptance for elastic insertion, interrupted motion and cleanup.
// Only initial drafts are seeded; every insertion and reorder uses Chrome input.
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
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-motion-browser-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-motion-test'});
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
const checks=[],errors=[],traces={},scale=.92;
const dragState='.drag-ghost,.being-dragged,.card-dragging,.delete-ready,.delete-hover,.drop-ready,.drop-target,.snap-preview,.snap-space,.has-snap-preview';
let browser,page,context,cdp;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  cdp=await context.newCDPSession(page);
  const nodes=()=>page.locator('#flowNodes .flow-node:not(.terminal)');
  const ids=()=>nodes().evaluateAll(elements=>elements.map(node=>node.dataset.node));
  const rects=()=>page.locator('#flowNodes .flow-node').evaluateAll(elements=>Object.fromEntries(elements.map(el=>{const r=el.getBoundingClientRect();return [el.dataset.node,{x:r.x,y:r.y,width:r.width,height:r.height}];})));
  async function settled(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function idle(){await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));await settled();}
  async function bounds(locator){const r=await locator.boundingBox();assert.ok(r,'element is visible');return r;}
  async function setup({chapter=4,task='delivery',count=3,width=1440,height=1000,reducedMotion='no-preference'}={}){
    await page.emulateMedia({reducedMotion});await page.setViewportSize({width,height});await page.goto(origin+'/teacher.html');
    await page.evaluate(async({chapter,task,count})=>{
      const engine=await import('/shared/engine.mjs'),db=await import('/db.js');
      const template=engine.exampleGraph(chapter,task).nodes.filter(node=>node.kind==='action');
      const actions=Array.from({length:count},(_,i)=>{const {actionId,params}=template[i%template.length];return {actionId,params};});
      await db.set('hasEntered',true);
      await db.set(`draft:practice:${chapter}:${task}`,{graph:engine.buildGraph(actions,{chapterId:chapter,taskId:task}),updatedAt:Date.now()});
      await db.set('last:practice',{chapter,taskId:task});
    },{chapter,task,count});
    await page.goto(origin+'/');await nodes().nth(count-1).waitFor();await page.locator('#transition').waitFor({state:'hidden'});await idle();
  }
  async function startDrag(source,{touch=false}={}){
    await idle();await source.scrollIntoViewIfNeeded();
    const box=await bounds(source),card=await source.evaluate(el=>{const r=(el.closest('.flow-node,[data-palette-drag]')||el).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    const start={x:box.x+box.width/2,y:box.y+box.height/2},offset={x:start.x-card.x,y:start.y-card.y};
    if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
    else{await page.mouse.move(start.x,start.y);await page.mouse.down();}
    return {
      card,offset,
      async move(point){
        if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...point,id:1}]});
        else await page.mouse.move(point.x,point.y);
        await settled();
      },
      async release(){if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up();},
      async cancel(kind='cancel'){
        if(kind==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
        else if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
        else await page.evaluate(()=>document.documentElement.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
        if(!touch)await page.mouse.up();
      }
    };
  }
  const align=(drag,rect,{fraction=.2,axis='y',direction=1}={})=>({
    x:rect.x+rect.width*(axis==='x'?(direction===1?fraction:1-fraction):.5)-drag.card.width*scale/2+drag.offset.x*scale,
    y:rect.y+rect.height*(axis==='y'?fraction:.5)-drag.card.height*scale/2+drag.offset.y*scale
  });
  async function record(){await page.evaluate(()=>{
    globalThis.__motionFrames=[];globalThis.__motionRecording=true;
    const capture=()=>{if(!globalThis.__motionRecording)return;globalThis.__motionFrames.push({time:performance.now(),nodes:Object.fromEntries([...document.querySelectorAll('#flowNodes .flow-node')].map(el=>{const r=el.getBoundingClientRect();return [el.dataset.node,{x:r.x,y:r.y,width:r.width,height:r.height}];})),active:!!document.querySelector('.layout-in-motion,.flow-shifting')});requestAnimationFrame(capture);};
    capture();
  });}
  async function stop(name){const trace=await page.evaluate(()=>{globalThis.__motionRecording=false;return globalThis.__motionFrames;});traces[name]=trace;return trace;}
  async function preview(side){assert.equal(await page.locator('#flowNodes .drop-target').getAttribute('data-drop-side'),side);assert.equal(await page.locator('.drag-ghost.is-snapped').count(),1);}
  async function clean(){await idle();await page.waitForFunction(()=>[...document.querySelectorAll('#flowNodes .flow-node')].flatMap(el=>el.getAnimations()).every(a=>a.playState!=='running'&&a.playState!=='pending'));assert.equal(await page.locator(dragState).count(),0,'drag state clears');assert.equal(await page.locator('.flow-shifting,.layout-in-motion').count(),0,'motion state clears');
    assert.equal(await page.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.flatMap(el=>el.getAnimations()).filter(a=>a.playState==='running'||a.playState==='pending').length),0,'no abandoned node animation remains');}
  async function restored(expected){const actual=await rects();for(const [id,r] of Object.entries(expected))for(const key of ['x','y','width','height'])assert.ok(Math.abs(actual[id][key]-r[key])<1,`${id} returns to its original ${key}`);}
  async function screenshot(name){if(output)await page.screenshot({path:join(output,name+'.png')});}
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function animated(trace,before,after){
    const moved=Object.keys(before).filter(id=>after[id]&&distance(before[id],after[id])>10);
    assert.ok(moved.length,'insertion moves existing blocks');
    assert.ok(moved.some(id=>trace.filter(frame=>frame.nodes[id]&&distance(frame.nodes[id],before[id])>1&&distance(frame.nodes[id],after[id])>1).length>=2),'existing blocks pass through multiple intermediate positions instead of teleporting');
    assert.ok(trace.some(frame=>frame.active),'motion is active during the transition');
  }

  await setup();
  {
    const order=await ids(),before=await rects(),target=before[order[1]],drag=await startDrag(page.locator('[data-coordinate=C]'));
    await record();await drag.move(align(drag,target));await preview('before');
    await page.waitForTimeout(70);await screenshot('delivery-mouse-moving');await idle();
    const after=await rects(),trace=await stop('delivery-insertion');animated(trace,before,after);
    const id=order[1],delta={x:after[id].x-before[id].x,y:after[id].y-before[id].y},length=Math.hypot(delta.x,delta.y);
    assert.ok(trace.some(frame=>{const r=frame.nodes[id];return r&&((r.x-after[id].x)*delta.x+(r.y-after[id].y)*delta.y)/length>.3;}),'elastic insertion has a small rebound past its settled position');
    await screenshot('delivery-mouse-open');await drag.cancel('blur');await clean();assert.deepEqual(await ids(),order);await restored(before);
  }
  checks.push('delivery: mouse insertion has intermediate frames and a small elastic rebound; blur animates back without mutation or residual state');

  await setup();
  {
    const order=await ids(),before=await rects(),target=before[order[1]],drag=await startDrag(page.locator('[data-coordinate=C]'),{touch:true});
    await record();await drag.move(align(drag,target));await preview('before');await page.waitForTimeout(25);
    await drag.move(align(drag,target,{fraction:.85}));await preview('after');await page.waitForTimeout(25);
    await drag.move(align(drag,target));await preview('before');await drag.release();await clean();
    const next=await ids(),added=next.find(id=>!order.includes(id));assert.deepEqual(next,[order[0],added,...order.slice(1)],'release during redirected motion keeps the last shown insertion side');
    const redirected=await stop('touch-redirect-release');
    const adjacent=redirected.slice(1).map((frame,i)=>({dt:frame.time-redirected[i].time,a:redirected[i].nodes[order[1]],b:frame.nodes[order[1]]})).filter(frame=>frame.dt<=40&&frame.a&&frame.b);
    assert.ok(adjacent.length>2&&adjacent.every(frame=>distance(frame.a,frame.b)<target.height),'rapid redirection continues from the visible position without a whole-block jump');
    await screenshot('delivery-touch-placed');
    await page.locator('#undoButton').click();await clean();assert.deepEqual(await ids(),order);
  }
  checks.push('delivery: touch redirects before/after/before before motion ends; immediate release inserts at the last shown side and undo restores order');

  await setup();
  {
    const order=await ids(),before=await rects(),drag=await startDrag(page.locator('[data-coordinate=C]'),{touch:true});
    await drag.move(align(drag,before[order[1]],{fraction:.85}));await drag.cancel();await clean();assert.deepEqual(await ids(),order);await restored(before);
    const existing=await startDrag(nodes().first().locator('[data-grip]'));
    await existing.move(align(existing,before[order.at(-1)],{fraction:.85}));await preview('after');await existing.release();await clean();
    assert.deepEqual(await ids(),[...order.slice(1),order[0]],'reorder released during motion uses stable original insertion geometry');
  }
  checks.push('delivery: touch cancellation restores positions; existing mouse reorder released during motion preserves exact final order');

  await setup({count:12,width:1024,height:768});
  {
    await nodes().last().scrollIntoViewIfNeeded();await idle();
    const order=await ids(),before=await rects(),drag=await startDrag(page.locator('[data-coordinate=C]'));
    assert.equal(Number(await page.locator('#flowNodes').getAttribute('data-columns')),1);
    assert.equal(await page.locator('#flowScroll').evaluate(el=>el.scrollHeight>el.clientHeight),true,'long program has internal vertical scrolling');
    await record();await drag.move(align(drag,before[order.at(-1)]));await preview('before');await idle();
    const after=await rects(),trace=await stop('delivery-scrolled-column');animated(trace,before,after);
    assert.ok(Object.keys(before).every(id=>Math.abs(after[id].x+after[id].width/2-before[id].x-before[id].width/2)<1),'insertion keeps all blocks on the same vertical centerline');
    assert.ok(Object.keys(before).some(id=>Math.abs(after[id].y-before[id].y)>10),'single-column insertion makes vertical room');
    await screenshot('delivery-scrolled-column-open');await drag.release();await clean();
    const next=await ids(),added=next.find(id=>!order.includes(id));assert.equal(next.indexOf(added),order.length-1);
  }
  checks.push('delivery: 1024px long program scrolls as one column, animates vertical space, then inserts before the selected last block');

  await setup({chapter:2,task:'fresh-juice',count:10,width:1024,height:768});
  {
    await nodes().first().scrollIntoViewIfNeeded();await idle();
    const order=await ids(),before=await rects(),drag=await startDrag(page.locator('#actionCards [data-palette-drag]').first(),{touch:true});
    await record();await drag.move(align(drag,before[order[0]],{fraction:.85}));await preview('after');await idle();
    animated(await stop('ordinary-vertical'),before,await rects());await screenshot('ordinary-vertical-open');await drag.release();await clean();
    const next=await ids(),added=next.find(id=>!order.includes(id));assert.equal(next.indexOf(added),1);
    const arrows=await page.locator('#flowEdges path[data-edge]').evaluateAll(paths=>paths.map(path=>{const m=path.getScreenCTM(),length=path.getTotalLength();const point=d=>{const p=path.getPointAtLength(d),s=new DOMPoint(p.x,p.y).matrixTransform(m);return {x:s.x,y:s.y};};return {length,start:point(0),end:point(length)};}));
    const boxes=await page.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};}));
    assert.equal(arrows.length,12);
    const near=(point,rect)=>Math.hypot(Math.max(rect.left-point.x,0,point.x-rect.right),Math.max(rect.top-point.y,0,point.y-rect.bottom))<=24;
    arrows.forEach((arrow,i)=>{assert.ok(arrow.length>0&&near(arrow.start,boxes[i])&&near(arrow.end,boxes[i+1]),`ordinary arrow ${i} remains connected after motion`);});
  }
  checks.push('fresh-juice: touch vertical insertion animates existing cards and keeps final arrows connected');

  await setup({reducedMotion:'reduce'});
  {
    const order=await ids(),before=await rects(),drag=await startDrag(page.locator('[data-coordinate=C]'));
    await record();await drag.move(align(drag,before[order[1]]));await preview('before');await settled();
    const first=await rects();await page.waitForTimeout(60);assert.deepEqual(await rects(),first,'reduced motion reaches its final geometry immediately');
    assert.equal(await page.locator('.flow-shifting,.layout-in-motion').count(),0);assert.equal(await page.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.flatMap(el=>el.getAnimations()).filter(a=>a.playState==='running'||a.playState==='pending').length),0);
    await stop('reduced-motion');await drag.cancel();await clean();await restored(before);assert.deepEqual(await ids(),order);
  }
  checks.push('reduced motion: insertion and cancellation reach stable geometry immediately without node animations');

  assert.deepEqual(errors,[]);if(output)writeFileSync(join(output,'motion-traces.json'),JSON.stringify(traces));console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}catch(error){
  if(output&&page)await page.screenshot({path:join(output,'motion-failure.png')}).catch(()=>{});
  throw error;
}finally{
  await cdp?.detach().catch(()=>{});await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});
}
