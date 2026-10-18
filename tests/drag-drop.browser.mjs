// Real-pointer regression: a destination accepts only a majority of the visible card.
// Draft setup is empty; all tested actions enter through actual drag gestures.
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
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-drag-browser-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-drag-test'});
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
const checks=[],errors=[],dragScale=.92;
let browser,page,context;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const cdp=await context.newCDPSession(page);
  const nodes=()=>page.locator('#flowNodes .flow-node:not(.terminal)');
  const ids=()=>nodes().evaluateAll(elements=>elements.map(node=>node.dataset.node));
  const coordinates=()=>nodes().evaluateAll(elements=>elements.map(node=>({x:Number(node.querySelector('[data-node-coordinate=x]').value),y:Number(node.querySelector('[data-node-coordinate=y]').value)})));
  async function settled(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function motionSettled(){await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));await settled();}
  async function setup(chapter,task){
    await page.goto(origin+'/teacher.html');
    await page.evaluate(async({chapter,task})=>{
      const engine=await import('/shared/engine.mjs'),db=await import('/db.js');
      await db.set('hasEntered',true);
      await db.set(`draft:practice:${chapter}:${task}`,{graph:engine.buildGraph([],{chapterId:chapter,taskId:task}),updatedAt:Date.now()});
      await db.set('last:practice',{chapter,taskId:task});
    },{chapter,task});
    await page.goto(origin+'/');await page.locator('#flowNodes .terminal').last().waitFor();
    await page.locator('#transition').waitFor({state:'hidden'});await settled();
  }
  async function bounds(selector){const box=await page.locator(selector).boundingBox();assert.ok(box,`${selector} is visible`);return {...box,right:box.x+box.width,bottom:box.y+box.height};}
  async function drag(source,target,{grab='center',touch=false,hover}={}){
    await motionSettled();await source.scrollIntoViewIfNeeded();
    if(await source.evaluate(el=>el.closest('.flow-node')?.classList.contains('snap-landed')||false))await page.waitForTimeout(320);
    const box=await source.boundingBox();assert.ok(box,'drag source is visible');
    const card=await source.evaluate(element=>{const r=(element.closest('.flow-node,[data-palette-drag]')||element).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    const start={x:box.x+(grab==='left'?7:grab==='right'?box.width-7:box.width/2),y:box.y+box.height/2};
    if(typeof target==='function')target=target({card,start,offset:{x:start.x-card.x,y:start.y-card.y}});
    if(touch){
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
      for(let i=1;i<=12;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(target.x-start.x)*i/12,y:start.y+(target.y-start.y)*i/12,id:1}]});
    }else{
      await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(target.x,target.y,{steps:16});
    }
    await settled();
    assert.equal(await page.locator('.drag-ghost').count(),1,'gesture creates one drag ghost');
    await page.waitForTimeout(120);await motionSettled();
    const ghost=await page.locator('.drag-ghost').boundingBox(),raw={x:target.x-(start.x-card.x)*dragScale,y:target.y-(start.y-card.y)*dragScale,width:card.width*dragScale,height:card.height*dragScale};
    if(await page.locator('.drag-ghost.is-snapped').count()){
      const editor=await bounds('.editor-panel');
      assert.ok(ratio(ghost,editor)>.99,'snapped ghost remains fully inside canvas');
      const blockers=await page.locator('#flowNodes .flow-node:not(.being-dragged)').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
      for(const block of blockers){
        const ix=Math.max(0,Math.min(ghost.x+ghost.width,block.right)-Math.max(ghost.x,block.x)),iy=Math.max(0,Math.min(ghost.y+ghost.height,block.bottom)-Math.max(ghost.y,block.y));
        assert.ok(ix<=1||iy<=1,'snapped ghost does not cover an original block');
      }
    }else{
      assert.ok(Math.abs(ghost.width-raw.width)<1&&Math.abs(ghost.height-raw.height)<1,'free ghost uses its actual shrunken footprint');
      assert.ok(Math.abs(ghost.x-raw.x)<2,`free ghost preserves original horizontal grab offset: ${JSON.stringify({ghost,start,target,card})}`);
      assert.ok(Math.abs(ghost.y-raw.y)<2,'free ghost preserves original vertical grab offset');
    }
    const pending=await page.locator('.snap-space').count()?await page.locator('.snap-space').boundingBox():null;
    if(pending)assert.ok(ghost.width<=pending.width*dragScale+1&&ghost.height<=pending.height*dragScale+1,'pending block shrinks relative to its normal insertion slot');
    else assert.ok(ghost.width<=card.width*dragScale+1&&ghost.height<=card.height*dragScale+1,'free card shrinks during the drag');
    // Acceptance follows the actual shrunken body before magnetic placement.
    if(hover)await hover({ghost:raw,visibleGhost:ghost,point:target,card});
    if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up();
    await motionSettled();
    assert.equal(await page.locator('.drag-ghost,.being-dragged,.card-dragging,.delete-ready,.delete-hover,.drop-ready,.drop-target,.snap-preview,.snap-space,.has-snap-preview').count(),0,'release clears all drag state');
  }
  async function add(source,target,options){const before=await nodes().count();await drag(source,target,options);assert.equal(await nodes().count(),before+1,'accepted canvas drop adds exactly one action');}
  async function remove(source,target,options){const before=await nodes().count();await drag(source,target,options);assert.equal(await nodes().count(),before-1,'accepted tool drop removes exactly one action');}
  async function undo(expected){await page.locator('#undoButton').click();await settled();assert.deepEqual(await ids(),expected,'undo restores exact action identities and order');}
  async function dismissInspector(){const done=page.locator('#inspector [data-edit=done]');if(await done.isVisible()){await done.click();await settled();}}
  const coordinate=id=>page.locator(`.coordinate-card[data-coordinate="${id}"]`);

  // Position the whole visible card, preserving its actual grab offset.
  const place=(zone,{edge='center',overlap=.75,top}={})=>({card,offset})=>({
    x:(edge==='left'?zone.x-card.width*dragScale*(1-overlap):edge==='right'?zone.right-card.width*dragScale*overlap:zone.x+(zone.width-card.width*dragScale)/2)+offset.x*dragScale,
    y:(top??zone.y+(zone.height-card.height*dragScale)/2)+offset.y*dragScale
  });
  const ratio=(ghost,zone)=>Math.max(0,Math.min(ghost.x+ghost.width,zone.right)-Math.max(ghost.x,zone.x))*Math.max(0,Math.min(ghost.y+ghost.height,zone.bottom)-Math.max(ghost.y,zone.y))/(ghost.width*ghost.height);
  const inside=(point,zone)=>point.x>=zone.x&&point.x<=zone.right&&point.y>=zone.y&&point.y<=zone.bottom;
  const preview=(zone,expected)=>async({ghost})=>{
    const overlap=ratio(ghost,zone);
    if(expected)assert.ok(overlap>.5,`visible card majority is inside destination: ${overlap}`);
    else assert.ok(overlap<=.50001,`visible card is at most half inside destination: ${overlap}`);
    assert.equal(await page.locator('.control-panel.delete-hover').count(),expected?1:0,'deletion preview follows card area');
  };

  await setup(4,'delivery');
  let editor=await bounds('.editor-panel'),flow=await bounds('#flowScroll'),tools=await bounds('.control-panel'),heading=await bounds('.editor-heading');
  const canvasHeading=place(editor,{top:heading.y+8});
  await add(coordinate('A'),canvasHeading,{grab:'left'});
  assert.equal(await nodes().last().locator('.block-destination').innerText(),'A');
  await add(coordinate('B'),place(editor,{edge:'left'}),{grab:'right'});
  await add(coordinate('C'),place(editor,{edge:'right'}),{grab:'left'});
  checks.push('delivery: heading and blank canvas accept coordinate cards when most of each card is inside');

  // A left-edge grab leaves the pointer in the editor while the card is mostly
  // over the tools; a right-edge grab keeps the pointer within the screen.
  for(const [label,grab,target] of [
    ['pointer remains in canvas','left',place(tools,{edge:'left',overlap:.7})],
    ['right-side grab in tools','right',place(tools,{edge:'right',overlap:1})],
    ['tool heading','left',place(tools,{top:tools.y+8})],
    ['tool bottom blank','right',place(tools,{top:tools.bottom-80})]
  ]){
    const before=await ids();
    await remove(nodes().first(),target,{grab,hover:async state=>{
      await preview(tools,true)(state);
      if(label==='pointer remains in canvas')assert.ok(inside(state.point,editor),'pointer is still in the canvas during majority-tool deletion');
    }});await undo(before);
    checks.push(`delivery: ${label} removes majority-overlapping block and undo restores it (${grab} grab)`);
  }

  const beforeCanvas=await ids();
  await drag(nodes().first(),place(editor,{edge:'right',overlap:.75}),{grab:'right',hover:async({ghost,point})=>{
    assert.ok(inside(point,tools),'pointer is in tools while block is mostly in canvas');
    assert.ok(ratio(ghost,editor)>.5);assert.equal(await page.locator('.control-panel.delete-hover').count(),0);
    assert.equal(await page.locator('#flowScroll.drop-ready').count(),1);
  }});
  assert.equal(await nodes().count(),beforeCanvas.length,'pointer in tools cannot delete a majority-canvas block');
  await dismissInspector();
  checks.push('delivery: a pointer in tools preserves a block whose majority remains in canvas');
  for(const overlap of [.2,.5]){
    const before=await ids(),params=await coordinates();
    await drag(nodes().first(),place(tools,{edge:'right',overlap}),{grab:'left',hover:preview(tools,false)});
    assert.deepEqual(await ids(),before);assert.deepEqual(await coordinates(),params);
    checks.push(`delivery: ${Math.round(overlap*100)}% tool overlap cancels deletion and preserves the program`);
  }
  for(const overlap of [.2,.5]){
    const before=await ids();
    await drag(coordinate('D'),place(editor,{edge:'left',overlap}),{grab:'right',hover:async({ghost})=>{
      assert.ok(ratio(ghost,editor)<=.50001);assert.equal(await page.locator('#flowScroll.drop-ready').count(),0);
    }});
    assert.deepEqual(await ids(),before,'at most half of a palette card in canvas does not add');
  }
  checks.push('delivery: 20% and 50% canvas overlap reject palette drops even when the pointer is inside canvas');
  await add(coordinate('D'),place(editor,{edge:'left',overlap:.75}),{grab:'left',hover:async({ghost,point})=>{
    assert.ok(!inside(point,editor),'pointer is outside canvas while palette card is mostly inside');
    assert.ok(ratio(ghost,editor)>.5);assert.equal(await page.locator('#flowScroll.drop-ready').count(),1);
  }});
  checks.push('delivery: majority-canvas palette drop adds a step while its pointer is outside canvas');
  const map=await bounds('#world'),outside={x:map.x+25,y:map.y+map.height/2};
  const beforeOutside=await ids(),paramsOutside=await coordinates();
  await drag(nodes().first().locator('[data-grip]'),outside);
  assert.deepEqual(await ids(),beforeOutside);assert.deepEqual(await coordinates(),paramsOutside);
  await drag(coordinate('D'),outside,{grab:'right'});assert.deepEqual(await ids(),beforeOutside);
  checks.push('delivery: clearly outside both destinations cancels existing-block and palette drags');

  // Target below the last action so the intended insertion side is unambiguous.
  const original=await ids(),targetBox=await nodes().last().boundingBox();
  await drag(nodes().first().locator('.node-number'),place(editor,{top:targetBox.y+targetBox.height-5}),{hover:async()=>assert.equal(await page.locator('#flowNodes .drop-target').count(),1,'reordering previews its insertion target')});
  assert.deepEqual(await ids(),[...original.slice(1),original[0]],'same-canvas mouse reorder respects after target');
  await undo(original);await dismissInspector();
  checks.push('delivery: right-side grab reorders within canvas with a visible insertion preview and undo');

  // Test named lower-road destinations independently of their card arrangement.
  for(const [name,point] of [['G',{x:4,y:3}],['H',{x:10,y:3}],['I',{x:16,y:3}]]){
    await add(coordinate(name),canvasHeading,{touch:true});
    assert.deepEqual((await coordinates())[0],point,`${name} card adds correct coordinates at heading insertion`);
    assert.equal(await nodes().first().locator('.block-destination').innerText(),name);
  }
  const touchProgram=await ids();
  await remove(nodes().first().locator('[data-grip]'),place(tools,{top:tools.bottom-80}),{touch:true,hover:preview(tools,true)});
  await undo(touchProgram);await dismissInspector();
  checks.push('delivery: touch adds G/H/I correctly, removes to tool blank space and undo restores the exact program');

  const first=()=>nodes().first();
  for(const [axis,value] of [['x','10'],['y','11']]){await first().locator(`[data-node-coordinate=${axis}]`).fill(value);await first().locator(`[data-node-coordinate=${axis}]`).press('Tab');}
  assert.equal(await first().locator('.block-destination').innerText(),'E');
  assert.match(await first().getAttribute('aria-label'),/移动到 E[（(]10[,，]\s*11[）)]/);
  await first().locator('[data-node-coordinate=x]').fill('9');await first().locator('[data-node-coordinate=x]').press('Tab');
  assert.equal(await first().locator('.block-destination').innerText(),'','unnamed road coordinate must not invent a destination');
  assert.doesNotMatch(await first().getAttribute('aria-label'),/移动到\s+[A-Z]/);
  await first().locator('[data-node-coordinate=x]').fill('10');await first().locator('[data-node-coordinate=x]').press('Tab');
  assert.equal(await first().locator('.block-destination').innerText(),'E','editing back to named point updates letter');
  checks.push('delivery: coordinate edits update named E and accessible text; unnamed road coordinates show no invented letter');
  if(output)await page.screenshot({path:join(output,'drag-delivery-destinations.png')});

  // Every regular task shares the same drag/drop implementation, but has its
  // own cards, arrow graph, inspector and task-specific layout pressure.
  for(const [chapter,task] of [[1,'drink-swap'],[2,'fresh-juice'],[3,'rice-roll'],[3,'tea'],[3,'plant'],[3,'fish']].filter(([,task])=>!process.env.SUPERMARKET_DRAG_TASK||task===process.env.SUPERMARKET_DRAG_TASK)){
    await setup(chapter,task);
    editor=await bounds('.editor-panel');flow=await bounds('#flowScroll');tools=await bounds('.control-panel');heading=await bounds('.editor-heading');
    const palette=()=>page.locator('#actionCards [data-palette-drag]');
    await add(palette().first(),place(editor,{top:heading.y+8}),{grab:'right'});
    await add(palette().nth(Math.min(1,(await palette().count())-1)),place(editor,{edge:'left',overlap:.75}),{grab:'left'});
    const order=await ids();
    await remove(nodes().first().locator('[data-grip]'),place(tools,{top:tools.bottom-80}),{hover:preview(tools,true)});await undo(order);
    const last=await nodes().last().boundingBox();
    await drag(nodes().first().locator('.node-number'),({card,offset})=>({x:last.x+(last.width-card.width*dragScale)/2+offset.x*dragScale,y:last.y+last.height-4+offset.y*dragScale-card.height*dragScale/2}));
    assert.deepEqual(await ids(),[order[1],order[0]],`${task}: ordinary flowchart reorders`);await undo(order);
    assert.equal(await page.locator('#flowEdges path[data-edge]').count(),3,`${task}: real arrows remain connected`);
    checks.push(`${task}: heading and near-edge add, blank-tool delete, same-canvas reorder, exact undo and arrows`);
    if(output&&task==='fresh-juice')await page.screenshot({path:join(output,'drag-ordinary-flowchart.png')});
  }
  // The 1024px landscape delete panel is only slightly wider than half a
  // delivery block. Both grab sides must still allow a natural in-screen drop.
  for(const [width,height] of [[1024,768],[768,1024]]){
    await page.setViewportSize({width,height});await setup(4,'delivery');
    editor=await bounds('.editor-panel');tools=await bounds('.control-panel');
    await add(coordinate('A'),place(editor),{touch:true});
    for(const [grab,touch] of [['left',false],['right',true]]){
      const before=await ids();
      await remove(nodes().first(),place(tools,{edge:'right',overlap:1}),{grab,touch,hover:async state=>{
        await preview(tools,true)(state);
        assert.ok(state.point.x>=0&&state.point.x<=width&&state.point.y>=0&&state.point.y<=height,'deletion pointer stays inside viewport');
        if(output&&grab==='right')await page.screenshot({path:join(output,`drag-delete-${width}x${height}.png`)});
      }});await undo(before);
    }
    checks.push(`${width}×${height}: delivery deletion accepts majority of a wide block using left mouse and right touch grabs with pointers inside viewport`);
  }
  await cdp.detach();assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,pageErrors:errors},null,2));
}catch(error){
  if(output&&page)await page.screenshot({path:join(output,'drag-failure.png')}).catch(()=>{});
  throw error;
}finally{
  await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
  rmSync(dataDir,{recursive:true,force:true});
}
