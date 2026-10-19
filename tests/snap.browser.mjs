// Real Chrome focus checks for visible, stable before/after snapping.
// Only empty drafts are seeded; actions and ordering use real pointer input.
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
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-snap-browser-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-snap-test'});
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
const checks=[],errors=[],dragScale=.92;
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
  const labels=()=>nodes().locator('.block-destination').allTextContents();
  const coordinate=id=>page.locator(`.coordinate-card[data-coordinate="${id}"]`);
  const dragState='.drag-ghost,.being-dragged,.card-dragging,.delete-ready,.delete-hover,.drop-ready,.drop-target,.snap-preview,.snap-space,.has-snap-preview';
  async function settled(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function motionSettled(){await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));await settled();}
  async function clean(){await motionSettled();assert.equal(await page.locator(dragState).count(),0,'all pointer state clears');}
  async function bounds(locator){const r=await locator.boundingBox();assert.ok(r,'element is visible');return {...r,right:r.x+r.width,bottom:r.y+r.height};}
  async function setup(chapter=4,task='delivery',viewport={width:1440,height:1000}){
    await page.setViewportSize(viewport);await page.goto(origin+'/teacher.html');
    await page.evaluate(async({chapter,task})=>{
      const engine=await import('/shared/engine.mjs'),db=await import('/db.js');
      await db.set('hasEntered',true);
      await db.set(`draft:practice:${chapter}:${task}`,{graph:engine.buildGraph([],{chapterId:chapter,taskId:task}),updatedAt:Date.now()});
      await db.set('last:practice',{chapter,taskId:task});
    },{chapter,task});
    await page.goto(origin+'/');await page.waitForFunction(()=>!document.querySelector('#submitButton').disabled);
    await page.locator('#transition').waitFor({state:'hidden'});await settled();
  }
  async function startDrag(source,{touch=false,grab='center'}={}){
    await motionSettled();await source.scrollIntoViewIfNeeded();
    if(await source.evaluate(el=>el.closest('.flow-node')?.classList.contains('snap-landed')||false))await page.waitForTimeout(320);
    const box=await bounds(source),card=await source.evaluate(element=>{const r=(element.closest('.flow-node,[data-palette-drag]')||element).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    const start={x:box.x+(grab==='left'?7:grab==='right'?box.width-7:box.width/2),y:box.y+box.height/2};
    const offset={x:start.x-card.x,y:start.y-card.y};let point=start;
    if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
    else{await page.mouse.move(start.x,start.y);await page.mouse.down();}
    return {
      card,offset,
      raw:()=>({x:point.x-offset.x*dragScale,y:point.y-offset.y*dragScale,width:card.width*dragScale,height:card.height*dragScale}),
      async move(next){
        if(touch){for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+(next.x-point.x)*i/8,y:point.y+(next.y-point.y)*i/8,id:1}]});}
        else await page.mouse.move(next.x,next.y,{steps:12});
        point=next;await settled();await page.waitForTimeout(120);assert.equal(await page.locator('.drag-ghost').count(),1,'one ghost follows active drag');
      },
      async finish(){if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up();await clean();},
      async cancel(kind='pointercancel'){
        if(kind==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
        else if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
        else await page.evaluate(()=>document.documentElement.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
        if(!touch)await page.mouse.up();await clean();
      }
    };
  }
  const align=(drag,rect,{fraction=.5,axis='y',direction=1}={})=>({
    x:rect.x+rect.width*(axis==='x'?(direction===1?fraction:1-fraction):.5)-drag.card.width*dragScale/2+drag.offset.x*dragScale,
    y:rect.y+rect.height*(axis==='y'?fraction:.5)-drag.card.height*dragScale/2+drag.offset.y*dragScale
  });
  async function preview(targetId,side){
    await motionSettled();
    const target=page.locator(`#flowNodes .drop-target[data-node="${targetId}"]`);
    assert.equal(await target.count(),1,'target has one explicit insertion preview');
    assert.equal(await target.getAttribute('data-drop-side'),side,'preview identifies insertion side');
    assert.equal(await page.locator('#flowScroll.drop-ready').count(),1,'canvas accepts the card');
    assert.equal(await page.locator('.drag-ghost').evaluate(el=>getComputedStyle(el).pointerEvents),'none','ghost leaves the pointer target reachable');
    const axis=await target.getAttribute('data-drop-axis'),direction=Number(await target.getAttribute('data-drop-direction'));
    const slot=page.locator('.snap-preview');assert.equal(await slot.count(),1,'one insertion slot is visible');
    assert.equal(await slot.getAttribute('data-snap-side'),side);assert.equal(await slot.getAttribute('data-snap-axis'),axis);
    assert.equal(await slot.innerText(),'','insertion seam stays free of instruction labels');
    const ghost=page.locator('.drag-ghost');assert.equal(await ghost.evaluate(el=>el.classList.contains('is-snapped')),true,'nearby card magnetizes');
    const g=await bounds(ghost),seam=await bounds(slot),editor=await bounds(page.locator('.editor-panel'));
    assert.ok(overlap(g,editor)>.99,'snapped ghost remains inside the canvas');
    assert.ok((axis==='y'?seam.height:seam.width)<=3,'insertion seam is only a small light');
    assert.equal(await slot.evaluate(el=>getComputedStyle(el).pointerEvents),'none');
    const viewport=page.viewportSize();assert.ok(seam.x>=0&&seam.y>=0&&seam.right<=viewport.width+1&&seam.bottom<=viewport.height+1,'seam stays inside the viewport');
    const blockers=await page.locator('#flowNodes .flow-node:not(.being-dragged)').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.node,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};}));
    for(const block of blockers){
      const ix=Math.max(0,Math.min(g.right,block.right)-Math.max(g.x,block.x)),iy=Math.max(0,Math.min(g.bottom,block.bottom)-Math.max(g.y,block.y));
      assert.ok(ix<=1||iy<=1,`snapped ghost leaves every original block readable: ${JSON.stringify({g,block})}`);
    }
    return {axis,direction};
  }
  async function addAtEnd(source,options){
    const terminals=page.locator('#flowNodes .terminal'),hasTerminals=await terminals.count()>0;
    const target=hasTerminals?terminals.last():await nodes().count()?nodes().last():page.locator('#flowScroll');
    await target.scrollIntoViewIfNeeded();await motionSettled();
    const before=await nodes().count(),end=await bounds(target),drag=await startDrag(source,options);
    await drag.move(align(drag,end,{fraction:hasTerminals?.15:.9}));await drag.finish();
    assert.equal(await nodes().count(),before+1,'end drop adds one action');
  }
  async function undo(order){await page.locator('#undoButton').click();await settled();assert.deepEqual(await ids(),order,'undo restores exact order');}
  async function screenshot(name){if(output)await page.screenshot({path:join(output,name+'.png')});}
  const overlap=(r,z)=>Math.max(0,Math.min(r.x+r.width,z.right)-Math.max(r.x,z.x))*Math.max(0,Math.min(r.y+r.height,z.bottom)-Math.max(r.y,z.y))/(r.width*r.height);
  const inPanel=(drag,panel,ratio=1)=>({x:panel.right-drag.card.width*dragScale*ratio+drag.offset.x*dragScale,y:panel.y+Math.min(90,(panel.height-drag.card.height*dragScale)/2)+drag.offset.y*dragScale});

  await setup();await addAtEnd(coordinate('A'));await addAtEnd(coordinate('B'));
  assert.deepEqual(await labels(),['A','B']);
  for(const touch of [false,true])for(const side of ['before','after']){
    const order=await ids(),targetId=order[1],target=await bounds(nodes().nth(1)),drag=await startDrag(coordinate('C'),{touch});
    await drag.move(align(drag,target,{fraction:side==='before'?.2:.8}));await preview(targetId,side);
    assert.match(await page.locator('.drag-ghost').innerText(),/移动到\s*C/,'palette preview becomes the pending move block');
    const small=await bounds(page.locator('.drag-ghost')),space=await bounds(page.locator('.snap-space'));assert.ok(small.width<space.width&&small.height<space.height,'pending block is smaller than its normal insertion slot');
    await screenshot(`delivery-${touch?'touch':'mouse'}-${side}`);
    await drag.finish();assert.deepEqual(await labels(),side==='before'?['A','C','B']:['A','B','C'],'released order matches displayed side');
    await page.waitForTimeout(320);
    const restored=await bounds(nodes().filter({has:page.locator('.block-destination', {hasText:'C'})}));
    const normal=await bounds(nodes().filter({has:page.locator('.block-destination', {hasText:'B'})}));
    assert.ok(Math.abs(restored.width-normal.width)<1&&Math.abs(restored.height-normal.height)<1,'released block restores the normal block size');
    await undo(order);
  }
  checks.push('delivery: mouse and touch upper/lower halves show different previews and insert at the displayed side');

  for(const side of ['before','after']){
    const order=await ids(),target=await bounds(nodes().nth(1)),drag=await startDrag(coordinate('C'));
    await drag.move(align(drag,target,{fraction:side==='before'?.2:.8}));await preview(order[1],side);
    for(const delta of [-2,2,-1,1]){await drag.move(align(drag,target,{fraction:.5+delta/target.height}));await preview(order[1],side);}
    await drag.move(align(drag,target,{fraction:.5+(side==='before'?16:-16)/target.height}));await preview(order[1],side==='before'?'after':'before');
    await drag.cancel('blur');assert.deepEqual(await ids(),order);
  }
  checks.push('delivery: 1–2 px midline jitter retains its prior side; clear midline crossing changes side; blur cancels without mutation');

  for(const touch of [false,true]){
    const order=await ids(),target=await bounds(nodes().nth(1)),drag=await startDrag(nodes().first().locator('[data-grip]'),{touch});
    await drag.move(align(drag,target,{fraction:.85}));await preview(order[1],'after');await drag.finish();
    assert.deepEqual(await ids(),[order[1],order[0]],'existing block reorders after target');await undo(order);
  }
  checks.push('delivery: mouse and touch existing blocks reorder to the shown slot with exact undo');

  for(const kind of ['pointercancel','blur']){
    const order=await ids(),target=await bounds(nodes().last()),drag=await startDrag(coordinate('C'),{touch:kind==='pointercancel'});
    await drag.move(align(drag,target,{fraction:.8}));await preview(order[1],'after');await drag.cancel(kind);assert.deepEqual(await ids(),order);
  }
  checks.push('delivery: pointer cancellation and window blur remove preview, ghost, and drag classes');

  const pendingOrder=await ids(),pendingId=pendingOrder[0];
  await nodes().first().locator('[data-node-coordinate=x]').fill('9');
  const dirtyTarget=await bounds(nodes().last()),dirtyDrag=await startDrag(nodes().first().locator('[data-grip]'));
  await dirtyDrag.move(align(dirtyDrag,dirtyTarget,{fraction:.85}));await preview(pendingOrder[1],'after');
  assert.equal(await page.locator(`#flowNodes [data-node="${pendingId}"] [data-node-coordinate=x]`).inputValue(),'9','input commits before capture replaces its source');
  const dirtyTools=await bounds(page.locator('.control-panel'));
  await dirtyDrag.move(inPanel(dirtyDrag,dirtyTools,.8));
  assert.equal(await page.locator('.control-panel.delete-hover').count(),1,'capture persists across the new input-rendered node');
  await dirtyDrag.move(align(dirtyDrag,dirtyTarget,{fraction:.85}));await preview(pendingOrder[1],'after');
  await dirtyDrag.finish();assert.deepEqual(await ids(),[pendingOrder[1],pendingId]);
  assert.equal(await page.locator(`#flowNodes [data-node="${pendingId}"] [data-node-coordinate=x]`).inputValue(),'9','reordered block retains committed coordinate');
  await undo(pendingOrder);
  checks.push('delivery: dragging a dirty coordinate commits its value, preserves capture across repeated tool/canvas crossings, reorders correctly, and clears state');


  for(const width of [1440,1024]){
    await setup(4,'delivery',{width,height:width===1440?1000:768});await addAtEnd(coordinate('A'));
    const editor=await bounds(page.locator('.editor-panel')),tools=await bounds(page.locator('.control-panel'));
    for(const fraction of [.2,.5,.75]){
      const order=await ids(),drag=await startDrag(nodes().first(),{grab:'left'});
      await drag.move(inPanel(drag,tools,fraction));assert.ok(Math.abs(overlap(drag.raw(),tools)-Math.min(fraction,tools.width/(drag.card.width*dragScale)))<.01,'deletion uses the actual shrunken card body area');
      assert.equal(await page.locator('.control-panel.delete-hover').count(),fraction>.5?1:0,JSON.stringify({width,fraction,card:drag.card,raw:drag.raw(),ghost:await bounds(page.locator('.drag-ghost')),tools}));
      await screenshot(`delete-${width}-${fraction}`);await drag.finish();
      assert.equal(await nodes().count(),fraction>.5?0:1,'tool requires more than half the actual shrunken card');
      if(fraction>.5)await undo(order);else assert.deepEqual(await ids(),order);
    }
    for(const fraction of [.2,.5,.75]){
      const order=await ids(),drag=await startDrag(coordinate('C'),{grab:'right'});
      // Editor left edge avoids overlap with the adjacent tool panel.
      await drag.move({x:editor.x-drag.card.width*dragScale*(1-fraction)+drag.offset.x*dragScale,y:editor.y+70+drag.offset.y*dragScale});
      assert.ok(Math.abs(overlap(drag.raw(),editor)-fraction)<.01,'canvas acceptance uses actual shrunken body area');
      assert.equal(await page.locator('#flowScroll.drop-ready').count(),fraction>.5?1:0);
      await drag.finish();assert.equal(await nodes().count(),fraction>.5?2:1);
      if(fraction>.5)await undo(order);else assert.deepEqual(await ids(),order);
    }
  }
  checks.push('1440 and 1024 px: 20%/50% tool and canvas overlap cancels; majority overlap deletes or adds; no residual pointer state');

  await setup(4,'delivery',{width:1024,height:768});
  for(let i=0;i<12;i++)await addAtEnd(coordinate('A'));
  assert.equal(Number(await page.locator('#flowNodes').getAttribute('data-columns')),1,'long delivery program retains one column');
  assert.equal(await page.locator('#flowScroll').evaluate(el=>el.scrollHeight>el.clientHeight),true,'long delivery program scrolls internally');
  for(const side of ['before','after']){
    await page.waitForTimeout(320);
    const targetIndex=7;
    await nodes().nth(targetIndex).evaluate(el=>el.scrollIntoView({block:'center'}));await motionSettled();
    const order=await ids(),target=await bounds(nodes().nth(targetIndex)),drag=await startDrag(coordinate('B'),{touch:true});
    await drag.move(align(drag,target,{fraction:side==='before'?.2:.8}));await preview(order[targetIndex],side);
    await drag.finish();const next=await ids(),added=next.find(id=>!order.includes(id));
    assert.equal(next.indexOf(added),targetIndex+(side==='before'?0:1),'scrolled single-column drop respects the selected side');await undo(order);
  }
  checks.push('delivery: long single-column program scrolls internally, keeps upper/lower seams visible and original blocks readable, and inserts at the shown side');

  await setup(2,'fresh-juice',{width:1024,height:768});
  const cards=()=>page.locator('#actionCards [data-palette-drag]');
  for(let i=0;i<10;i++)await addAtEnd(cards().nth(i%await cards().count()));
  assert.equal(Number(await page.locator('#flowNodes').getAttribute('data-columns')),1,'ordinary graph retains one column at 1024px');
  await nodes().first().scrollIntoViewIfNeeded();await motionSettled();
  const order=await ids(),target=await bounds(nodes().first()),drag=await startDrag(cards().nth(2));
  // Ordinary flowcharts use the same upper/lower insertion direction as delivery.
  await drag.move(align(drag,target,{fraction:.8}));
  const ordinaryPreview=await preview(order[0],'after');assert.equal(ordinaryPreview.axis,'y');
  await screenshot('ordinary-flowchart-snap');await drag.finish();
  const next=await ids();assert.equal(next.indexOf(order[0])+1,next.findIndex(id=>!order.includes(id)));
  await page.locator('#chainButton').click();await page.waitForFunction(()=>!document.querySelector('#flowCanvas').classList.contains('flow-forming'));
  assert.equal(await page.locator('#flowEdges path[data-edge]').count(),12,'ordinary arrows remain connected');
  checks.push('fresh-juice: ordinary flowchart keeps vertical insertion and connected arrows');

  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}catch(error){
  if(output&&page)await page.screenshot({path:join(output,'snap-failure.png')}).catch(()=>{});
  throw error;
}finally{
  await cdp?.detach().catch(()=>{});await browser?.close();
  if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});
}
