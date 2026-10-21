// Real-pointer acceptance for chapter 2: sort operation cards, then form a flowchart.
// The only seeded browser state selects the chapter; all work uses student controls.
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
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-fruit-flow-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-fruit-flow-test'});
const output=resolve(process.env.SUPERMARKET_TEST_OUTPUT||'/tmp/supermarket-fruit-flow-qa');
assert.ok(output.startsWith('/tmp/')||output.startsWith('/private/tmp/'),'screenshots must stay under /tmp');
mkdirSync(output,{recursive:true});
const checks=[],errors=[];
let browser,page,context,cdp;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  cdp=await context.newCDPSession(page);
  const nodes=()=>page.locator('#flowNodes .flow-node:not(.terminal)');
  const ids=()=>nodes().evaluateAll(elements=>elements.map(el=>el.dataset.node));
  const labels=()=>nodes().locator('.node-copy strong').allTextContents();
  const saved=()=>page.evaluate(async()=>await(await import('/db.js')).get('draft:practice:2:fresh-juice'));
  const expected=['清洗橙子','去皮切块','放入橙肉','启动机器榨汁','果汁出品'];
  async function settled(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function idle(){await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting,.flow-forming'));await settled();}
  async function poll(check,label,timeout=10000){const until=Date.now()+timeout;while(Date.now()<until){if(await check())return;await page.waitForTimeout(60);}throw new Error(`Timed out: ${label}`);}
  async function shot(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});}
  async function sorting(count){
    await idle();assert.equal(await nodes().count(),count);
    assert.equal(await page.locator('#flowNodes .terminal').count(),0,'sorting shows operation cards only');
    assert.equal(await page.locator('#flowEdges path[data-edge]').count(),0,'sorting shows no arrows');
    assert.equal(await page.locator('#flowNodes .port').count(),0,'sorting shows no connection ports');
    assert.equal(await page.locator('#connectButton').isVisible(),false,'sorting does not expose manual connection');
    assert.equal(await page.locator('#runButton').isDisabled(),true,'sort first, form before running');
    assert.equal((await page.locator('#chainButton').textContent()).trim(),'按排序形成流程图');
  }
  async function drag(source,target,{touch=false}={}){
    await idle();await source.scrollIntoViewIfNeeded();
    if(await source.evaluate(el=>el.closest('.flow-node')?.classList.contains('snap-landed')||false))await page.waitForTimeout(320);
    const box=await source.boundingBox();assert.ok(box,'drag source visible');
    const start={x:box.x+box.width/2,y:box.y+box.height/2};
    const destination=typeof target==='function'?await target():target;
    if(touch){
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
      for(let i=1;i<=16;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(destination.x-start.x)*i/16,y:start.y+(destination.y-start.y)*i/16,id:1}]});
    }else{await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(destination.x,destination.y,{steps:18});}
    await settled();assert.equal(await page.locator('.drag-ghost').count(),1,'real gesture creates a drag ghost');
    await page.waitForTimeout(120);
    if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up();
    await idle();assert.equal(await page.locator('.drag-ghost,.being-dragged,.card-dragging,.snap-space').count(),0,'release clears transient drag state');
  }
  async function append(action,{touch=false}={}){
    const count=await nodes().count();
    await drag(page.locator(`#actionCards [data-action="${action}"]`),async()=>{
      const box=await(count?nodes().last():page.locator('#flowScroll')).boundingBox();
      return {x:box.x+box.width/2,y:count?box.y+box.height*.9:box.y+box.height/2};
    },{touch});
    assert.equal(await nodes().count(),count+1,'palette drag adds exactly one card');
  }
  async function formed(order){
    await idle();assert.deepEqual(await ids(),order,'formation preserves operation identities and order');
    assert.equal(await page.locator('#flowNodes .terminal').count(),2,'formation adds start and end');
    assert.equal(await page.locator('#flowEdges path[data-edge]').count(),order.length+1,'formation connects every adjacent step');
    assert.equal(await page.locator('#runButton').isEnabled(),true,'formed flowchart can run');
    const paths=await page.locator('#flowEdges path[data-edge]').evaluateAll(elements=>elements.map(el=>({length:el.getTotalLength(),opacity:Number(getComputedStyle(el).opacity)})));
    assert.ok(paths.every(path=>path.length>0&&path.opacity===1),'formed arrows have real visible geometry');
  }
  async function form(order,{record=false}={}){
    if(record)await page.evaluate(()=>{
      window.__fruitFormationFrames=[];window.__fruitFormationRecording=true;
      const capture=()=>{if(!window.__fruitFormationRecording)return;const canvas=document.querySelector('#flowCanvas');window.__fruitFormationFrames.push({time:performance.now(),forming:canvas.classList.contains('flow-forming'),animations:canvas.getAnimations({subtree:true}).filter(a=>a.playState==='running'||a.playState==='pending').length,terminals:document.querySelectorAll('#flowNodes .terminal').length,arrows:document.querySelectorAll('#flowEdges path[data-edge]').length});requestAnimationFrame(capture);};capture();
    });
    await page.locator('#chainButton').click();
    await page.waitForFunction(()=>document.querySelector('#flowCanvas').classList.contains('flow-forming'));
    assert.equal(await page.locator('#runButton').isDisabled(),true,'formation animation locks execution');
    await shot('fruit-forming');await formed(order);
    if(record){
      const frames=await page.evaluate(()=>{window.__fruitFormationRecording=false;return window.__fruitFormationFrames;});
      assert.ok(frames.some(frame=>frame.forming&&frame.animations>0),'formation visibly animates the new flowchart');
      assert.ok(frames.filter(frame=>frame.forming).length>=5,'formation remains observable across animation frames');
      writeFileSync(join(output,'formation-frames.json'),JSON.stringify(frames,null,2));
    }
  }

  await page.goto(origin+'/teacher.html');
  await page.evaluate(async()=>{const db=await import('/db.js');await db.set('hasEntered',true);await db.set('last:practice',{chapter:2,taskId:'fresh-juice'});});
  await page.goto(origin+'/');await page.locator('#transition').waitFor({state:'hidden'});
  await poll(()=>page.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),'fruit chapter opens');
  await sorting(0);assert.equal(await page.locator('#chainButton').isDisabled(),true,'empty sorting cannot form a flowchart');
  await shot('fruit-empty');checks.push('fresh fruit canvas has no start/end, arrows or ports; empty formation and execution are disabled');

  for(const action of ['peel_cut','wash_orange','add_orange','start_juicer','serve_juice'])await append(action,{touch:action==='add_orange'});
  await sorting(5);assert.deepEqual(await labels(),[expected[1],expected[0],...expected.slice(2)]);
  const unsorted=await ids(),target=await nodes().nth(1).boundingBox();
  await drag(nodes().first(),{x:target.x+target.width/2,y:target.y+target.height*.9});
  const order=[unsorted[1],unsorted[0],...unsorted.slice(2)];
  assert.deepEqual(await ids(),order,'pointer reorder puts preparation steps in the chosen order');
  assert.deepEqual(await labels(),expected);await sorting(5);
  await poll(async()=>JSON.stringify((await saved())?.graph.nodes.filter(n=>n.kind==='action').map(n=>n.id))===JSON.stringify(order),'sorting saved');
  await shot('fruit-sorted');await page.reload();
  // The transition overlay starts hidden, so wait for the restored fruit scene
  // and its cards instead of asserting against the still-empty document.
  await poll(()=>page.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),'fruit scene restores after reload');
  await poll(()=>nodes().count().then(count=>count===5),'sorted cards restore after reload');
  await sorting(5);assert.deepEqual(await ids(),order);
  checks.push('mouse and touch drags add five operation cards; real reorder changes sequence; unformed order survives refresh');

  await form(order,{record:true});await shot('fruit-formed');
  await poll(async()=>(await saved())?.graph.edges.length===6,'formed draft saved');
  const formedGraph=(await saved()).graph;
  await page.reload();
  await poll(()=>page.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),'formed scene restores after reload');
  await poll(()=>page.locator('#flowNodes .terminal').count().then(count=>count===2),'formed terminals restore after reload');
  await formed(order);
  assert.deepEqual((await saved()).graph,formedGraph,'refresh preserves generated draft and graph metadata');
  await shot('fruit-formed-reloaded');checks.push('button forms terminals and arrows with visible animation, preserving card order and the generated draft across refresh');
  const arrowPoint=await page.locator('#flowEdges path[data-edge]').first().evaluate(el=>{const point=el.getPointAtLength(el.getTotalLength()/2),screen=new DOMPoint(point.x,point.y).matrixTransform(el.getScreenCTM());return {x:screen.x,y:screen.y};});
  await page.mouse.click(arrowPoint.x,arrowPoint.y);await settled();await formed(order);
  assert.deepEqual((await saved()).graph.edges,formedGraph.edges,'clicking an automatic fruit arrow cannot delete the connection');
  assert.equal(await page.locator('#chainButton').isEnabled(),true,'formed work can replay formation');
  await form(order);assert.deepEqual((await saved()).graph.nodes,formedGraph.nodes,'replaying formation preserves every node and its order');
  checks.push('automatic fruit arrows resist click deletion; formed work can replay formation without changing its nodes or order');

  await page.locator('#runButton').click();
  await page.waitForFunction(()=>!!document.querySelector('#flowNodes .executing.terminal'));
  await page.locator('#pauseButton').click();
  const pausedNode=await page.locator('#flowNodes .executing').getAttribute('data-node');
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#flowNodes .executing').getAttribute('data-node'),pausedNode,'pause holds the current executing node');
  assert.equal((await page.locator('#pauseButton').textContent()).trim(),'继续');
  await page.locator('#stopButton').click();await formed(order);
  assert.equal(await page.locator('#flowNodes .executing').count(),0,'stop clears execution highlight');
  assert.deepEqual(await ids(),order,'pause and stop preserve the formed graph');
  await page.evaluate(()=>{
    window.__fruitRunFrames=[];window.__fruitRunRecording=true;
    const capture=()=>{if(!window.__fruitRunRecording)return;const active=document.querySelector('#flowNodes .executing');window.__fruitRunFrames.push({time:performance.now(),id:active?.dataset.node||null,terminal:active?.classList.contains('terminal')||false});requestAnimationFrame(capture);};capture();
  });
  await page.locator('#runButton').click();
  await page.waitForFunction(()=>!!document.querySelector('#flowNodes .executing'));
  assert.equal(await page.locator('#stopButton').isEnabled(),true,'run exposes stop while executing');
  await page.locator('#result').waitFor({state:'visible',timeout:60000});
  assert.match(await page.locator('#result').textContent(),/任务完成/);
  await poll(()=>page.locator('#runButton').isEnabled(),'run ends');await shot('fruit-run-completed');
  const runs=await page.evaluate(async()=>(await(await import('/db.js')).all('run:practice:')).map(entry=>entry.value));
  const completed=runs.find(run=>run.chapterId===2&&run.status==='completed');assert.ok(completed?.valid);
  assert.equal(completed.executedNodes.length,7);assert.deepEqual(completed.graph.nodes.filter(n=>n.kind==='action').map(n=>n.id),order);
  const frames=await page.evaluate(()=>{window.__fruitRunRecording=false;return window.__fruitRunFrames;});
  writeFileSync(join(output,'run-frames.json'),JSON.stringify(frames,null,2));
  const sequence=frames.filter(frame=>frame.id).reduce((list,frame)=>list.at(-1)===frame.id?list:[...list,frame.id],[]);
  assert.deepEqual(sequence,completed.executedNodes,'visible highlight follows start, five actions and end in execution order');
  for(const id of [completed.executedNodes[0],completed.executedNodes.at(-1)]){
    const terminalFrames=frames.filter(frame=>frame.id===id);assert.ok(terminalFrames.every(frame=>frame.terminal));
    assert.ok(terminalFrames.at(-1).time-terminalFrames[0].time>=400,'start and end each visibly highlight for at least 400ms');
  }
  const metrics=await page.evaluate(async graph=>(await import('/shared/engine.mjs')).simulate(graph).metrics,completed.graph);
  assert.deepEqual(completed.metrics,metrics,'animation dwell does not add task time');
  assert.ok(runs.some(run=>run.chapterId===2&&run.status==='stopped'&&!run.valid),'stopped playback remains an invalid interrupted record');
  checks.push('run highlights start → four actions → end, holds both terminals at least 400ms, supports pause/stop, records completion, and excludes animation time from task metrics');

  const last=await nodes().last().boundingBox();
  await drag(nodes().first(),{x:last.x+last.width/2,y:last.y+last.height*.9},{touch:true});
  await sorting(5);assert.deepEqual(await ids(),[...order.slice(1),order[0]],'editing a generated graph resets it to sorting');
  await page.locator('#undoButton').click();await formed(order);
  const tools=await page.locator('.control-panel').boundingBox();
  await drag(nodes().last(),{x:tools.x+tools.width/2,y:tools.y+tools.height-70});
  await sorting(4);assert.deepEqual(await ids(),order.slice(0,-1));
  await page.locator('#undoButton').click();await formed(order);await shot('fruit-undo-restored');
  await page.locator('#clearButton').click();await sorting(0);
  await page.locator('#undoButton').click();await formed(order);
  checks.push('touch reordering and drag-back deletion return generated work to sorting; undo restores exact formed order, terminals and arrows; clear/undo also restores it');

  for(const chapter of [1,2,3,4]){
    // Switching stations briefly disables the tabs while the draft saves.
    await poll(()=>page.locator(`[data-chapter="${chapter}"]`).isEnabled(),`chapter ${chapter} tab enabled`);
    await page.locator(`[data-chapter="${chapter}"]`).click();
    await page.locator('#transition').waitFor({state:'hidden'});await poll(()=>page.locator('#submitButton').isEnabled(),`chapter ${chapter} ready`);await idle();
    if(chapter!==2){
      assert.equal(await page.locator('#flowNodes .terminal').count(),2,`chapter ${chapter} keeps its ordinary start/end behavior`);
      if(chapter!==4)assert.equal((await page.locator('#chainButton').textContent()).trim(),'按排列连线',`chapter ${chapter} retains ordinary connection control`);
    }
    await page.locator('#submitButton').tap();await page.locator('#submitDialog').waitFor({state:'visible'});
    const goal=await page.locator('#submitRatingGoal').textContent();
    assert.match(goal,new RegExp(`活动\\s*${chapter}`));assert.doesNotMatch(goal,/任务\s*[1-4]/);
    assert.equal((await page.locator('#submitRatingTitle').textContent()).trim(),'给自己的学习打星');
    await shot(`activity-${chapter}-submit`);await page.locator('#submitDialog .dialog-close').tap();
  }
  checks.push('four chapter self-assessment goals say 活动 1–4; other chapters retain their ordinary terminal and connection behavior');

  // A separate device fixtures an old draft with actions but no edges or stage.
  // Repair must update only its active draft, preserving old run/submission snapshots.
  const originalPage=page,legacyContext=await browser.newContext({viewport:{width:1440,height:1000}});
  page=await legacyContext.newPage();page.on('pageerror',error=>errors.push(`legacy: ${error.message}`));
  await page.goto(origin+'/teacher.html');
  const legacy=await page.evaluate(async()=>{
    const db=await import('/db.js'),engine=await import('/shared/engine.mjs'),graph=engine.exampleGraph(2,'fresh-juice');
    const result=engine.simulate(graph),run={id:'legacy-run',runId:'legacy-run',chapterId:2,taskId:'fresh-juice',graph:structuredClone(graph),executedNodes:graph.nodes.map(n=>n.id),status:'completed',valid:true,result,metrics:result.metrics,createdAt:Date.now()-60000};
    const submission={submissionId:'legacy-submission',chapterId:2,taskId:'fresh-juice',source:'student',graph:structuredClone(graph),selfAssessment:{goalId:2,stars:2},createdAt:Date.now()-50000};
    const draft={...structuredClone(graph),edges:[]};
    await db.set('hasEntered',true);await db.set('last:practice',{chapter:2,taskId:'fresh-juice'});
    await db.set('draft:practice:2:fresh-juice',{graph:draft,updatedAt:Date.now()});
    await db.set('run:practice:legacy-run',run);await db.set('submission:practice:legacy-submission',submission);
    return {draft,run,submission};
  });
  await page.goto(origin+'/');
  // The overlay starts hidden; wait for the legacy draft to render before asserting.
  await poll(()=>page.locator('#sceneTitle').textContent().then(text=>text.includes('水果')),'legacy fruit scene opens');
  await poll(()=>nodes().count().then(count=>count===5),'legacy cards render');
  await idle();
  const legacyOrder=legacy.draft.nodes.filter(n=>n.kind==='action').map(n=>n.id);
  assert.deepEqual(await ids(),legacyOrder);assert.equal(await page.locator('#flowNodes .terminal').count(),2);
  assert.equal(await page.locator('#flowEdges path[data-edge]').count(),0,'legacy missing edges remain visible as an incomplete draft');
  assert.equal(await page.locator('#chainButton').isEnabled(),true,'legacy draft with actions exposes repair');
  await form(legacyOrder);await poll(async()=>(await saved())?.graph.edges.length===6,'legacy repair saved');
  assert.deepEqual((await saved()).graph.nodes,legacy.draft.nodes,'legacy repair preserves every existing node');
  const history=await page.evaluate(async()=>{const db=await import('/db.js');return {run:await db.get('run:practice:legacy-run'),submission:await db.get('submission:practice:legacy-submission')};});
  assert.deepEqual(history,{run:legacy.run,submission:legacy.submission},'repair leaves historical run and submission snapshots unchanged');
  await shot('fruit-legacy-repaired');await legacyContext.close();page=originalPage;
  checks.push('an old draft with action nodes and missing edges can regenerate its connections while preserving all nodes and historical run/submission snapshots');
  assert.deepEqual(errors,[]);
  const report={ok:true,checks,pageErrors:errors,screenshots:output};writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(page)await page.screenshot({path:join(output,'fruit-failure.png'),fullPage:true}).catch(()=>{});throw error;
}finally{await cdp?.detach().catch(()=>{});await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dataDir,{recursive:true,force:true});}
