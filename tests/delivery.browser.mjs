// Real Chrome acceptance. Only an empty initial draft is seeded; every program
// step is created and edited through the student's actual touch/editor controls.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createClassroomServer} from '../server.mjs';
import {DELIVERY_MAP,exampleGraph,availableActions} from '../shared/engine.mjs';

const locations=[process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean);
let playwright;
for(const location of locations){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Playwright is required; set PLAYWRIGHT_MODULE to its installed index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-delivery-browser-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-delivery-test'});
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
const checks=[],errors=[],animationChecks=[];
let browser;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  // Same-origin DB setup never writes an example solution or changes app code.
  await page.goto(origin+'/teacher.html');
  await page.evaluate(async()=>{
    const engine=await import('/shared/engine.mjs'),db=await import('/db.js');
    await db.set('hasEntered',true);
    await db.set('draft:practice:2:fresh-juice',{graph:engine.buildGraph([],{chapterId:2,taskId:'fresh-juice'}),updatedAt:Date.now()});
    await db.set('last:practice',{chapter:2,taskId:'fresh-juice'});
  });
  await page.goto(origin+'/');
  await page.locator('#sceneTitle').filter({hasText:'水果区鲜榨橙汁'}).waitFor();
  await page.locator('#transition').waitFor({state:'hidden'});

  async function poll(check,{timeout=12000,label='condition'}={}){
    const deadline=Date.now()+timeout;let value;
    while(Date.now()<deadline){value=await check();if(value)return value;await page.waitForTimeout(80);}
    throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(value)}`);
  }
  async function canvasFingerprint(){
    return page.locator('#world canvas').evaluate(canvas=>{
      const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let hash=2166136261,painted=0;
      for(let i=0;i<data.length;i+=16){hash=Math.imul(hash^data[i],16777619);hash=Math.imul(hash^data[i+1],16777619);hash=Math.imul(hash^data[i+2],16777619);if(data[i]+data[i+1]+data[i+2]>60)painted++;}
      return {hash:hash>>>0,painted,width:canvas.width,height:canvas.height};
    });
  }
  async function savedRuns(){
    return page.evaluate(async()=>{const db=await import('/db.js');return (await db.all('run:practice:')).map(row=>row.value).sort((a,b)=>a.createdAt-b.createdAt);});
  }
  async function chooseChapter(chapter){
    await page.locator(`[data-chapter="${chapter}"]`).tap();
    await page.locator(`[data-chapter="${chapter}"].active`).waitFor();
    await page.locator('#transition').waitFor({state:'hidden'});
    await poll(()=>page.locator('#submitButton').isEnabled(),{label:`chapter ${chapter} editable`});
  }
  async function mouseDrag(source,target){
    const box=await source.boundingBox();assert.ok(box,'drag source must be visible');
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(target.x,target.y,{steps:14});await page.mouse.up();
  }
  async function addAction(actionId){
    const before=await page.locator('#flowNodes .flow-node').count();
    const source=page.locator(`#actionCards [data-action="${actionId}"]`);
    const nodes=page.locator('#flowNodes .flow-node'),target=await nodes.count()?nodes.last():page.locator('#flowScroll');
    await source.scrollIntoViewIfNeeded();await target.scrollIntoViewIfNeeded();
    const end=await target.boundingBox(),flow=await page.locator('#flowScroll').boundingBox();
    assert.ok(end&&flow);
    await mouseDrag(source,{x:end.x+end.width/2,y:Math.min(end.y+end.height*.9,flow.y+flow.height-6)});
    await poll(async()=>await page.locator('#flowNodes .flow-node').count()===before+1,{label:`mouse-dragged ${actionId}`});
  }
  async function finishRun({animated=false,pause=false,label='run'}={}){
    if(await page.locator('#flowCanvas').evaluate(el=>el.classList.contains('fruit-sorting'))){await page.locator('#chainButton').tap();await page.waitForFunction(()=>!document.querySelector('#runButton').disabled);}
    const previous=(await savedRuns()).length;
    const fingerprints=new Set(),times=[];
    const initial=await canvasFingerprint();assert.ok(initial.painted>0&&initial.width>0&&initial.height>0);
    fingerprints.add(initial.hash);
    await page.locator('#runButton').tap();
    if(pause){
      await poll(async()=>Number(await page.locator('#timeValue').textContent())>=2,{label:'delivery advances before pause'});
      await page.locator('#pauseButton').tap();
      await page.waitForTimeout(150);
      const frozen=await page.locator('#timeValue').textContent();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#timeValue').textContent(),frozen,'pause must preserve simulated time');
      await page.locator('#pauseButton').tap();
    }
    const deadline=Date.now()+65000;
    while(Date.now()<deadline){
      fingerprints.add((await canvasFingerprint()).hash);
      times.push(Number(await page.locator('#timeValue').textContent()));
      if(await page.locator('#result').isVisible() && await page.locator('#runButton').isEnabled())break;
      await page.waitForTimeout(120);
    }
    await page.locator('#result').waitFor({state:'visible',timeout:1000});
    await poll(()=>page.locator('#runButton').isEnabled(),{label:`${label} complete`});
    await poll(async()=>{const runs=await savedRuns();return runs.length===previous+1&&runs.at(-1).status!=='running';},{label:`${label} persisted`});
    if(animated){assert.ok(fingerprints.size>=3,`${label}: map did not visibly animate`);animationChecks.push({label,distinctFrames:fingerprints.size,distinctTimes:new Set(times).size});}
    return (await savedRuns()).at(-1);
  }

  // Toolbox clicks are intentionally inert; only dragging creates a step.
  const initialNodeCount=await page.locator('#flowNodes .flow-node').count();
  await page.locator('#actionCards [data-action=start_juicer]').tap();await page.waitForTimeout(100);
  assert.equal(await page.locator('#flowNodes .flow-node').count(),initialNodeCount,'clicking a palette card must not add a step');
  checks.push('clicking a toolbox action leaves the program unchanged');
  // Starting an empty machine must stop before any action animation or mutation.
  await addAction('start_juicer');
  const invalid=await finishRun({label:'empty juicer rejection'});
  assert.equal(invalid.valid,false);assert.equal(invalid.status,'failed');assert.equal(invalid.result.errorNodeId,invalid.graph.nodes.find(node=>node.kind==='action').id);
  assert.match(await page.locator('#result').textContent(),/放入橙肉/);
  assert.equal(invalid.result.finalState.flags.start_juicer,undefined);
  checks.push('chapter 2 refuses starting the juicer before loading orange flesh');

  await page.locator('#clearButton').tap();
  for(const action of availableActions(2,'fresh-juice'))await addAction(action.actionId);
  const juice=await finishRun({animated:true,label:'five-step fresh orange juice'});
  assert.equal(juice.valid,true);assert.equal(juice.result.completed,true);
  assert.deepEqual(juice.graph.nodes.filter(node=>node.kind==='action').map(node=>node.actionId),['wash_orange','peel_cut','add_orange','start_juicer','pack_juice']);
  assert.deepEqual(Object.keys(juice.result.finalState.flags),['wash_orange','peel_cut','add_orange','start_juicer','pack_juice']);
  assert.match(await page.locator('#result').textContent(),/任务完成/);
  checks.push('all five juice steps are added through the real toolbox and animate to completion');

  await chooseChapter(3);
  await page.locator('[data-practice-task="rice-roll"]').tap();
  await page.locator('#actionCards [data-action=seaweed]').waitFor();
  assert.equal(await page.locator('[data-practice-task="rice-roll"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(await page.locator('#practiceTasks [data-practice-task]').evaluateAll(options=>options.map(option=>option.dataset.practiceTask)),['rice-roll','tea','plant','fish']);
  assert.match(await page.locator('#taskGoal').textContent(),/切段装盒/);
  checks.push('rice-roll is available among the four chapter 3 practice jobs');

  await chooseChapter(4);await page.locator('#clearButton').tap();
  assert.equal(await page.locator('#flowNodes .program-block').count(),2);
  assert.equal(await page.locator('#flowEdges path').count(),0,'delivery uses blocks without arrows');
  assert.match(await page.locator('#rules').textContent(),/A、E含冷藏/);
  assert.match((await page.locator('#deliveryOrders .cold').allTextContents()).join(' '),/酸奶/);
  assert.match(await page.locator('#deliveryOrders .order-card').filter({hasText:'D饼干订单'}).textContent(),/56分钟/);
  assert.deepEqual(await page.locator('#coordinateCards .cold-coordinate').evaluateAll(nodes=>nodes.map(node=>node.dataset.coordinate)),['A','E']);
  const coordinateFor=params=>Object.entries(DELIVERY_MAP.points).filter(([id])=>!id.startsWith('J')).find(([,point])=>point.x===params.x&&point.y===params.y)?.[0];
  const bestCoordinates=exampleGraph(4,'delivery','best').nodes.filter(node=>node.kind==='action').map(node=>coordinateFor(node.params));
  const cdp=await context.newCDPSession(page);
  async function dragCoordinate(id){
    const before=await page.locator('#flowNodes .program-block').count();
    const source=id.startsWith('J')?page.locator('#actionCards [data-action=move_to]'):page.locator(`.coordinate-card[data-coordinate="${id}"]`);
    await source.scrollIntoViewIfNeeded();
    await page.locator('#flowNodes .block-end').scrollIntoViewIfNeeded();
    const from=await source.boundingBox(),end=await page.locator('#flowNodes .block-end').boundingBox(),flow=await page.locator('#flowScroll').boundingBox();
    assert.ok(from&&end&&flow,'coordinate source and program canvas must be visible');
    const start={x:from.x+from.width/2,y:from.y+from.height/2},target={x:end.x+end.width/2,y:Math.min(end.y+end.height/2,flow.y+flow.height-6)};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
    for(let i=1;i<=12;i++){
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(target.x-start.x)*i/12,y:start.y+(target.y-start.y)*i/12,id:1}]});
      await page.waitForTimeout(18);
    }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await poll(async()=>await page.locator('#flowNodes .program-block').count()===before+1,{label:`touch drag coordinate ${id}`});
    if(id.startsWith('J')){const added=page.locator('#flowNodes .program-block:not(.terminal)').last(),point=DELIVERY_MAP.points[id];for(const axis of ['x','y']){await added.locator(`[data-node-coordinate=${axis}]`).fill(String(point[axis]));await added.locator(`[data-node-coordinate=${axis}]`).press('Tab');}}
  }
  await page.locator('.coordinate-card[data-coordinate=A]').tap();await page.waitForTimeout(100);
  assert.equal(await page.locator('#flowNodes .program-block').count(),2,'clicking a coordinate must not add a block');
  assert.deepEqual(await page.locator('.coordinate-card').evaluateAll(cards=>cards.map(card=>card.dataset.coordinate)),['W','A','B','C','D','E','F','G','H','I']);
  assert.doesNotMatch(await page.locator('#coordinateCards').innerText(),/J[012]|\bx\b|\by\b/);
  assert.match(await page.locator('.coordinate-card[data-coordinate=A]').innerText(),/A[\s\S]*[（(]4[,，]\s*7[）)]/);
  // All three named lower-road junctions are real touch-draggable positions.
  for(const [id,expected] of [['G',{x:4,y:3}],['H',{x:10,y:3}],['I',{x:16,y:3}]]){
    await dragCoordinate(id);
    const params=await page.locator('#flowNodes .program-block:not(.terminal)').last().evaluate(node=>({x:Number(node.querySelector('[data-node-coordinate=x]').value),y:Number(node.querySelector('[data-node-coordinate=y]').value)}));assert.deepEqual(params,expected,`${id} must add its advertised coordinate`);
    assert.equal(await page.locator('#flowNodes .program-block:not(.terminal)').last().locator('.block-destination').innerText(),id,`${id} block must show its map letter`);
  }
  await page.locator('#clearButton').tap();assert.equal(await page.locator('#flowNodes .program-block').count(),2);
  checks.push('G, H and I touch drags create the three lower-road coordinates without exposing internal J names');
  for(const id of bestCoordinates)await dragCoordinate(id);
  const first=()=>page.locator('#flowNodes .program-block:not(.terminal)').first();
  const programCoordinates=()=>page.locator('#flowNodes .program-block:not(.terminal)').evaluateAll(nodes=>nodes.map(node=>({x:Number(node.querySelector('[data-node-coordinate=x]').value),y:Number(node.querySelector('[data-node-coordinate=y]').value)})));
  // Filling a live coordinate leaves its change event pending. The following
  // real mouse press must keep dragging after blur rerenders the source node.
  await page.waitForTimeout(650);
  const pendingNode=first(),pendingId=await pendingNode.getAttribute('data-node');
  await pendingNode.locator('[data-node-coordinate=x]').fill('9');
  const grip=await pendingNode.locator('[data-grip]').boundingBox(),flowBounds=await page.locator('#flowScroll').boundingBox(),toolsBounds=await page.locator('.control-panel').boundingBox();assert.ok(grip&&flowBounds&&toolsBounds);
  const originPoint={x:grip.x+grip.width/2,y:grip.y+grip.height/2};
  await page.mouse.move(originPoint.x,originPoint.y);await page.mouse.down();
  for(const point of [{x:flowBounds.x+25,y:flowBounds.y+70},{x:toolsBounds.x+toolsBounds.width/2,y:toolsBounds.y+80},{x:flowBounds.x+flowBounds.width/2,y:flowBounds.y+flowBounds.height-40},{x:toolsBounds.x+toolsBounds.width/2,y:toolsBounds.y+120},originPoint]){
    await page.mouse.move(point.x,point.y,{steps:16});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    const ghost=page.locator('.drag-ghost');assert.equal(await ghost.count(),1,'pending input blur must not disconnect the drag');
    const box=await ghost.boundingBox();assert.ok(box);
    if(await ghost.evaluate(node=>node.classList.contains('is-snapped'))){
      const slot=await page.locator('.snap-space').boundingBox();assert.ok(slot,'snapped ghost has an insertion space');
      assert.ok(Math.abs(box.x-(slot.x+slot.width*.04))<2&&Math.abs(box.y-(slot.y+slot.height*.04))<2,'snapped ghost aligns with its displayed insertion space');
      assert.ok(Math.abs(box.width-slot.width*.92)<2&&Math.abs(box.height-slot.height*.92)<2,'snapped ghost retains the advertised smaller size');
    }else assert.ok(Math.abs(box.x-point.x)<210&&Math.abs(box.y-point.y)<110,`free ghost follows pointer: pointer=${JSON.stringify(point)}, ghost=${JSON.stringify(box)}`);
  }
  await page.mouse.up();await poll(async()=>await page.locator('.drag-ghost,.being-dragged,.card-dragging,.delete-ready,.delete-hover,.drop-ready').count()===0,{label:'cross-column drag cleanup'});
  const pendingCard=page.locator(`#flowNodes [data-node="${pendingId}"]`);assert.equal(await pendingCard.locator('[data-node-coordinate=x]').inputValue(),'9');
  assert.equal(await pendingCard.locator('.block-destination').innerText(),'','unnamed road coordinate must not retain a stale destination letter');
  await pendingCard.locator('[data-node-coordinate=x]').fill('10');await pendingCard.locator('[data-node-coordinate=x]').press('Tab');
  assert.deepEqual(await programCoordinates(),exampleGraph(4,'delivery','best').nodes.filter(node=>node.kind==='action').map(node=>node.params));
  checks.push('pending coordinate blur keeps a long repeated cross-column drag attached; free ghost follows the pointer, snapped ghost aligns with its insertion space, and release cleans all drag state');
  await page.waitForTimeout(650); // settle touch input and its delayed compatibility click before mouse dragging
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const beforeDelete=await programCoordinates(),beforeDeleteCount=await page.locator('#flowNodes .program-block').count();
  const toolbox=await page.locator('.control-panel').boundingBox(),deletionBlock=await first().boundingBox();assert.ok(toolbox&&deletionBlock);
  const deletionSource=await first().locator('[data-grip]').evaluate(element=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {x:r.left,y:r.top,width:r.width,height:r.height,hit:hit?.outerHTML};});
  await page.evaluate(()=>{globalThis.__deleteDragEvents=[];globalThis.__deleteDragObserver=event=>globalThis.__deleteDragEvents.push({type:event.type,x:event.clientX,y:event.clientY,pointerType:event.pointerType,target:event.target?.className});for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.addEventListener(type,globalThis.__deleteDragObserver,{capture:true});});
  // Align the visible block with the delete panel; the left grip remains in
  // the canvas when the block is wider than the toolbox.
  await mouseDrag(first().locator('[data-grip]'),{x:toolbox.x+(toolbox.width-deletionBlock.width)/2+(deletionSource.x+deletionSource.width/2-deletionBlock.x),y:toolbox.y+70});
  try{await poll(async()=>await page.locator('#flowNodes .program-block').count()===beforeDeleteCount-1,{label:'dragging a block back to toolbox deletes it'});}catch(error){throw new Error(`${error.message}; source=${JSON.stringify(deletionSource)}; target=${JSON.stringify(toolbox)}; events=${JSON.stringify(await page.evaluate(()=>globalThis.__deleteDragEvents))}`);}
  await page.evaluate(()=>{for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.removeEventListener(type,globalThis.__deleteDragObserver,{capture:true});delete globalThis.__deleteDragObserver;delete globalThis.__deleteDragEvents;});
  assert.deepEqual(await programCoordinates(),beforeDelete.slice(1));
  await page.locator('#undoButton').tap();assert.deepEqual(await programCoordinates(),beforeDelete);
  checks.push('coordinate clicks add nothing; dragging an existing block back to the toolbox deletes it, and undo restores the exact program');
  // The inspector uses an empty data-destination attribute; selecting an address
  // must update both coordinates, rather than silently ignoring its change event.
  await page.waitForTimeout(650); // the last touch drag suppresses its synthetic click
  await first().locator('.block-copy > span').first().tap();
  await page.locator('#inspector select[data-destination]').waitFor({state:'visible'});
  await page.locator('#inspector select[data-destination]').selectOption('A');
  assert.equal(await first().locator('.block-destination').innerText(),'A');
  assert.equal(await first().locator('[data-node-coordinate=x]').inputValue(),'4');
  assert.equal(await first().locator('[data-node-coordinate=y]').inputValue(),'7');
  await page.locator('#inspector select[data-destination]').selectOption('W');
  assert.equal(await first().locator('.block-destination').innerText(),'W');
  assert.equal(await first().locator('[data-node-coordinate=x]').inputValue(),'10');
  assert.equal(await first().locator('[data-node-coordinate=y]').inputValue(),'1');
  assert.equal(await page.locator('#inspector [data-destination] option[value^=J]').count(),0);
  await first().locator('[data-node-coordinate=y]').fill('3');await first().locator('[data-node-coordinate=y]').press('Tab');
  await page.locator('#inspector [data-edit=done]').tap();
  checks.push('selecting a map destination in the real inspector updates both block coordinates');
  // Coordinate fields are real editable inputs; change both axes and restore them.
  for(const [axis,temporary,correct] of [['x','4','10'],['y','7','3']]){
    await first().locator(`[data-node-coordinate="${axis}"]`).fill(temporary);
    await first().locator(`[data-node-coordinate="${axis}"]`).press('Tab');
    assert.equal(await first().locator(`[data-node-coordinate="${axis}"]`).inputValue(),temporary);
    await first().locator(`[data-node-coordinate="${axis}"]`).fill(correct);
    await first().locator(`[data-node-coordinate="${axis}"]`).press('Tab');
    assert.equal(await first().locator(`[data-node-coordinate="${axis}"]`).inputValue(),correct);
  }
  const best=await finishRun({animated:true,pause:true,label:'touch-drag best delivery'});
  assert.deepEqual(best.graph.nodes.filter(node=>node.kind==='action').map(node=>node.params),exampleGraph(4).nodes.filter(node=>node.kind==='action').map(node=>node.params));
  assert.deepEqual(best.metrics,{walk:36,handling:12,total:48,onTime:true,coins:117,delivered:6,failed:0});
  assert.equal(await page.locator('#timeValue').textContent(),'48');assert.equal(await page.locator('#coinsValue').textContent(),'117');
  assert.equal(await page.locator('#deliveredValue').textContent(),'6 / 6');assert.equal(await page.locator('#failedValue').textContent(),'0');
  assert.equal(await page.locator('#deliveryOrders .delivered').count(),6);assert.match(await page.locator('#result').textContent(),/48[\s\S]*分钟/);assert.match(await page.locator('#deliveryOrders').textContent(),/26分钟/);assert.doesNotMatch(await page.locator('#deliveryOrders').textContent(),/秒/);assert.match(await page.locator('#result').textContent(),/六单全部成功送达/);
  checks.push('eight real touch drags plus inline coordinate edits create the best route; pause freezes time; delivery animates to 48 minutes, 117 coins, six successes');
  if(output)await page.screenshot({path:join(output,'delivery-best.png')});

  await page.locator('#clearButton').tap();assert.equal(await page.locator('#flowNodes .program-block').count(),2);
  for(const node of exampleGraph(4,'delivery','bad').nodes.filter(node=>node.kind==='action'))await dragCoordinate(coordinateFor(node.params));
  const bad=await finishRun({animated:true,label:'touch-dragged late-cold-orders delivery'});
  assert.equal(bad.valid,true);assert.equal(bad.status,'completed');
  assert.deepEqual(bad.metrics,{walk:36,handling:12,total:48,onTime:false,coins:84,delivered:5,failed:1});
  assert.equal(await page.locator('#timeValue').textContent(),'48');assert.equal(await page.locator('#coinsValue').textContent(),'84');
  assert.equal(await page.locator('#deliveredValue').textContent(),'5 / 6');assert.equal(await page.locator('#failedValue').textContent(),'1');
  assert.equal(await page.locator('#deliveryOrders .spoiled').count(),1);assert.equal(await page.locator('#deliveryOrders .delivered').count(),5);
  assert.match(await page.locator('#result.error').textContent(),/1单超时/);
  assert.match(await page.locator('#comparison').textContent(),/首次[\s\S]*117[\s\S]*本次[\s\S]*84[\s\S]*最好[\s\S]*117/);
  assert.match(await page.locator('#comparison').textContent(),/金币减少 33/);
  await page.locator('#routesButton').tap();
  checks.push('clearing and dragging coordinates creates the late route; A is late, score is 84, and comparison preserves the 117-coin first/best route');
  if(output)await page.screenshot({path:join(output,'delivery-bad-comparison.png')});

  const deliveryRuns=(await savedRuns()).filter(run=>run.taskId==='delivery');
  assert.equal(deliveryRuns.length,2);assert.ok(deliveryRuns.every(run=>run.valid&&run.status==='completed'));
  assert.deepEqual(deliveryRuns.map(run=>[run.metrics.total,run.metrics.coins,run.metrics.failed]),[[48,117,0],[48,84,1]]);
  assert.deepEqual(deliveryRuns[0].graph,best.graph,'second run must not mutate the first saved program');
  await page.locator('#historyButton').tap();await page.locator('#historyDialog').waitFor({state:'visible'});
  const history=await page.locator('#historyList').textContent();
  assert.match(history,/用时48分钟/);assert.match(history,/社区配送[\s\S]*完成 · 有订单失败/);assert.match(history,/金币84，失败1单/);assert.match(history,/金币117，失败0单/);assert.match(history,/鲜榨橙汁/);
  assert.equal(await page.locator('#historyList [data-history]').count(),4);
  await page.locator('#historyList [data-history]').first().tap();assert.match(await page.locator('#historyList').textContent(),/移动到/);
  await page.locator('#historyDialog .dialog-close').tap();
  checks.push('history retains the failed juicer attempt, successful juice and both immutable delivery programs, including spoiled-order completion');

  // Portrait keeps result/compare/help inside the scrollable tools. The failed
  // run must reveal its concrete coordinate error without manual page scrolling.
  await page.setViewportSize({width:768,height:1024});
  await poll(async()=>await page.locator('#sceneDetailsSlot .scene-bottom').count()===1,{label:'portrait scene details moved into tools'});
  await page.locator('#clearButton').tap();
  await dragCoordinate('H');
  await first().locator('[data-node-coordinate=x]').fill('5');
  await first().locator('[data-node-coordinate=x]').press('Tab');
  await first().locator('[data-node-coordinate=y]').fill('5');
  await first().locator('[data-node-coordinate=y]').press('Tab');
  const invalidCoordinate=await finishRun({label:'portrait invalid coordinate'});
  assert.equal(invalidCoordinate.valid,false);assert.equal(invalidCoordinate.result.errors[0].code,'PARAMS');
  assert.match(await page.locator('#result').textContent(),/道路.*整数格|坐标/);
  for(const selector of ['#result','#comparison','.scene-help','#rules'])assert.equal(await page.locator(`#sceneDetailsSlot ${selector}`).count(),1,`portrait tools must contain ${selector}`);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const resultBounds=await page.locator('#result').boundingBox();
  assert.ok(resultBounds&&resultBounds.x>=0&&resultBounds.y>=0&&resultBounds.x+resultBounds.width<=769&&resultBounds.y+resultBounds.height<=1025,`portrait error result must be inside the viewport: ${JSON.stringify(resultBounds)}`);
  const resultHit=await page.locator('#result').evaluate(element=>{const r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});
  assert.equal(resultHit,true,'portrait error result must be visible above clipping and overlays');
  checks.push('768×1024 invalid coordinate reveals a visible result inside the viewport; results, comparison and rules stay in the scrollable tools');
  if(output)await page.screenshot({path:join(output,'delivery-portrait-invalid.png')});

  // Loading/restoring an unmarked program creates a current-rule draft. The
  // saved old run remains authoritative and cannot displace the new-rule best.
  const legacyBefore=await page.evaluate(async()=>{
    const engine=await import('/shared/engine.mjs'),db=await import('/db.js');
    const graph=engine.buildGraph(['H','B','A','D','E','F','C'].map(id=>({actionId:'move_to',params:engine.DELIVERY_MAP.points[id]})),{chapterId:4,taskId:'delivery'});
    delete graph.deliveryRulesVersion;
    const result=engine.simulate(graph),run={id:'legacy-rule-acceptance',runId:'legacy-rule-acceptance',chapterId:4,taskId:'delivery',graph,result,metrics:result.metrics,trace:result.trace,status:'completed',valid:true,createdAt:Date.now()+1};
    await db.set('run:practice:'+run.id,run);await db.set('draft:practice:4:delivery',{graph,updatedAt:Date.now()});return run;
  });
  assert.equal(legacyBefore.metrics.coins,115);
  await page.reload();await page.locator('#transition').waitFor({state:'hidden'});
  await poll(()=>page.locator('#runButton').isEnabled(),{label:'upgraded legacy draft loaded'});
  assert.match(await page.locator('#comparison').textContent(),/首次[\s\S]*117[\s\S]*本次[\s\S]*84[\s\S]*最好[\s\S]*117/);
  assert.doesNotMatch(await page.locator('#comparison').textContent(),/115/);
  const upgraded=await page.evaluate(async()=>{const db=await import('/db.js');return (await db.get('draft:practice:4:delivery')).graph;});
  assert.equal(upgraded.deliveryRulesVersion,'split-cold-v2');
  await page.locator('#historyButton').tap();await page.locator('[data-restore="legacy-rule-acceptance"]').tap();
  await page.waitForTimeout(800);
  const afterRestore=await page.evaluate(async()=>{const db=await import('/db.js');return {run:await db.get('run:practice:legacy-rule-acceptance'),graph:(await db.get('draft:practice:4:delivery')).graph};});
  assert.deepEqual(afterRestore.run,legacyBefore);assert.equal(afterRestore.graph.deliveryRulesVersion,'split-cold-v2');
  assert.deepEqual(afterRestore.graph.nodes,legacyBefore.graph.nodes);
  checks.push('legacy draft loads/restores with current rules; old 115-coin history remains byte-for-byte unchanged and is excluded from current-rule comparison');

  await cdp.detach();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,animationChecks,pageErrors:errors},null,2));
}finally{
  await browser?.close();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  rmSync(dataDir,{recursive:true,force:true});
}
