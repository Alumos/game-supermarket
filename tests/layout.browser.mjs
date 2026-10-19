// Responsive layout acceptance uses real touch input and the real offline rules.
// Fixtures seed fresh example drafts and reserve the real classroom-notice space.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createClassroomServer} from '../server.mjs';

const locations=[process.env.PLAYWRIGHT_MODULE,'playwright','/Users/alumos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean);
let playwright;
for(const location of locations){try{playwright=await import(location);break;}catch{}}
if(!playwright)throw new Error('Playwright is required; set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dataDir=mkdtempSync(join(tmpdir(),'supermarket-layout-browser-'));
const {server}=createClassroomServer({dataDir,teacherKey:'isolated-layout-test'});
const output=process.env.SUPERMARKET_TEST_OUTPUT?resolve(process.env.SUPERMARKET_TEST_OUTPUT):null;
if(output)mkdirSync(output,{recursive:true});
const cases=[{chapter:1,task:'drink-swap',steps:3},{chapter:2,task:'fresh-juice',steps:5},{chapter:3,task:'rice-roll',steps:5},{chapter:3,task:'tea',steps:5},{chapter:3,task:'plant',steps:5},{chapter:3,task:'fish',steps:5},{chapter:4,task:'delivery',steps:8}];
const viewports=[{width:1440,height:900},{width:1366,height:768},{width:1280,height:720},{width:1180,height:820},{width:1024,height:768},{width:768,height:1024}];
const results=[],errors=[];
// Reproduce CSS rejection in Chromium 99. This does not replace Win7 hardware QA.
const legacyCss=process.env.SUPERMARKET_LEGACY_LAYOUT==='1'||process.argv.includes('--legacy-css');
function unsupportedCssRemoved(css){
  return css.replace(/[\w-]+:[^;{}]*dvh[^;{}]*(?:;|(?=}))/g,'')
    .replace(/([^{}]+)\{([^{}]*)\}/g,(rule,selector)=>selector.includes(':has(')?'':rule);
}
async function configureContext(context){
  if(!legacyCss)return;
  for(const file of ['app.css','teacher.css'])await context.route(`**/${file}`,route=>route.fulfill({status:200,contentType:'text/css',body:unsupportedCssRemoved(readFileSync(new URL('../public/'+file,import.meta.url),'utf8'))}));
}
let browser;
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright.chromium.launch({headless:true,...existsSync(chrome)?{executablePath:chrome}:{},args:['--no-sandbox']});
  for(const scenario of cases.filter(scenario=>!process.env.SUPERMARKET_LAYOUT_TASK||scenario.task===process.env.SUPERMARKET_LAYOUT_TASK)){
    const context=await browser.newContext({viewport:viewports[0],hasTouch:true});
    await configureContext(context);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(`${scenario.task}: ${e.message}`));
    await page.goto(origin+'/teacher.html');
    scenario.steps=await page.evaluate(async({chapter,task})=>{
      const engine=await import('/shared/engine.mjs'),db=await import('/db.js');
      await db.set('hasEntered',true);
      const graph=engine.exampleGraph(chapter,task);
      await db.set(`draft:practice:${chapter}:${task}`,{graph,updatedAt:Date.now()});
      await db.set('last:practice',{chapter,taskId:task});
      return graph.nodes.length-2;
    },scenario);
    await page.goto(origin+'/');await page.locator('#flowNodes .flow-node').nth(scenario.steps+1).waitFor();
    await page.locator('#transition').waitFor({state:'hidden'});
    async function settled(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForFunction(()=>!document.querySelector('.layout-in-motion,.flow-shifting'));await page.waitForTimeout(100);}
    async function measure(label){
      // Toasts are temporary action feedback; inspect the settled workspace.
      await page.locator('#toast').waitFor({state:'hidden'});
      await settled();
      const layout=await page.evaluate(()=>{
        const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
        const flow=document.querySelector('#flowScroll');
        return {
          viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
          header:rect(document.querySelector('.topbar')),scene:rect(document.querySelector('.scene-panel')),editor:rect(document.querySelector('.editor-panel')),tools:rect(document.querySelector('.control-panel')),world:rect(document.querySelector('#world')),run:rect(document.querySelector('#runButton')),
          footer:rect(document.querySelector('.site-footer')),registration:rect(document.querySelector('.site-footer a')),submit:rect(document.querySelector('#submitButton')),
          columns:Number(document.querySelector('#flowNodes').dataset.columns),
          palette:[...document.querySelectorAll('#actionCards [data-palette-drag]')].map(rect),
          inspector:document.querySelector('#inspector').hidden?null:{...rect(document.querySelector('#inspector')),controls:[...document.querySelectorAll('#inspector label,#inspector input,#inspector select,#inspector button')].map(element=>{
            const bounds=rect(element);let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
            for(let parent=element.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent),r=rect(parent);if(/hidden|clip|auto|scroll/.test(style.overflowX)){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right);}if(/hidden|clip|auto|scroll/.test(style.overflowY)){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom);}}
            const hit=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
            return {name:element.id||element.textContent.trim()||element.tagName,...bounds,clip,covered:!element.contains(hit)&&!hit?.contains(element)};
          })},
          flow:{...rect(flow),scrollHeight:flow.scrollHeight,clientHeight:flow.clientHeight,scrollWidth:flow.scrollWidth,clientWidth:flow.clientWidth,scrollTop:flow.scrollTop,scrollLeft:flow.scrollLeft},
          nodes:[...document.querySelectorAll('#flowNodes .flow-node')].map(node=>{
            const bounds=rect(node),hit=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
            return {id:node.dataset.node,terminal:node.classList.contains('terminal'),...bounds,coveredBy:hit?.id||hit?.className,covered:hit?.closest('[data-node]')?.dataset.node!==node.dataset.node};
          })
        };
      });
      const describe=`${scenario.task} ${layout.viewport.width}×${layout.viewport.height} ${label}`;
      const diagnostic=()=>JSON.stringify(layout);
      assert.equal(layout.nodes.length,scenario.steps+2,describe+': expected complete graph');
      assert.ok(layout.document.width<=layout.viewport.width+1,describe+': page horizontal overflow '+diagnostic());
      assert.ok(layout.document.height<=layout.viewport.height+1,describe+': page vertical overflow '+diagnostic());
      assert.ok(Math.abs(layout.footer.bottom-layout.viewport.height)<=1,describe+': registration footer stays at viewport bottom');
      assert.ok(layout.registration.top>=layout.footer.top&&layout.registration.bottom<=layout.footer.bottom+1,describe+': registration link stays inside its footer');
      for(const [name,bounds] of [['scene',layout.scene],['editor',layout.editor],['tools',layout.tools]])assert.ok(bounds.bottom<=layout.footer.top+1,describe+`: ${name} is above the registration footer`);
      for(const [name,bounds] of [['map',layout.world],['run button',layout.run],['submit button',layout.submit],['registration link',layout.registration]]){
        assert.ok(bounds.width>0&&bounds.height>0,describe+`: ${name} is empty`);
        assert.ok(bounds.left>=-1&&bounds.top>=-1&&bounds.right<=layout.viewport.width+1&&bounds.bottom<=layout.viewport.height+1,describe+`: ${name} outside viewport `+diagnostic());
      }
      if(layout.viewport.width>layout.viewport.height){
        assert.ok(layout.header.height<=60,describe+': landscape header is compact');
        assert.ok(layout.editor.width>layout.scene.width&&layout.editor.width>layout.tools.width,describe+': middle canvas should be the widest');
        assert.ok(Math.abs(layout.scene.top-layout.editor.top)<=1&&Math.abs(layout.tools.top-layout.editor.top)<=1&&Math.abs(layout.scene.bottom-layout.editor.bottom)<=1&&Math.abs(layout.tools.bottom-layout.editor.bottom)<=1,describe+': three columns must align at top and bottom');
        assert.ok(layout.editor.left>=layout.scene.right-1,describe+': map and editor should be side by side');
      }
      assert.equal(layout.columns,1,describe+': every program remains a single vertical column');
      for(const [index,card] of layout.palette.entries()){
        assert.ok(Math.abs(card.left-layout.palette[0].left)<=1&&Math.abs(card.width-layout.palette[0].width)<=1,describe+': operations share one full-width vertical column');
        if(index)assert.ok(card.top>=layout.palette[index-1].bottom-1,describe+': operations follow each other downwards');
      }
      if(scenario.chapter===2||scenario.chapter===3)assert.equal(layout.inspector,null,describe+': fixed operations have no step inspector');
      const center=layout.nodes[0].left+layout.nodes[0].width/2;
      for(const [index,node] of layout.nodes.entries()){
        assert.ok(Math.abs(node.left+node.width/2-center)<=1,describe+`: ${node.id} shares the vertical centerline`);
        if(index)assert.ok(node.top>=layout.nodes[index-1].bottom-1,describe+`: ${node.id} follows the previous node downwards`);
      }
      if(layout.inspector){
        assert.ok(layout.inspector.bottom<=layout.run.top+1,describe+': inspector clears execution buttons');
        for(const control of layout.inspector.controls){
          assert.ok(control.width>0&&control.height>0,describe+`: inspector ${control.name} is empty`);
          assert.ok(control.left>=control.clip.left-1&&control.right<=control.clip.right+1&&control.top>=control.clip.top-1&&control.bottom<=control.clip.bottom+1,describe+`: inspector ${control.name} is clipped `+JSON.stringify(control));
          assert.equal(control.covered,false,describe+`: inspector ${control.name} is covered`);
        }
      }
      {
        assert.ok(layout.flow.scrollHeight<=layout.flow.clientHeight+2,describe+': flow requires vertical scrolling '+diagnostic());
        assert.ok(layout.flow.scrollWidth<=layout.flow.clientWidth+2,describe+': flow requires horizontal scrolling '+diagnostic());
        for(const node of layout.nodes){
          assert.ok(node.left>=layout.flow.left-1&&node.right<=layout.flow.right+1&&node.top>=layout.flow.top-1&&node.bottom<=layout.flow.bottom+1,describe+`: ${node.id} outside visible flow `+diagnostic());
          assert.equal(node.covered,false,describe+`: ${node.id} covered by ${node.coveredBy}`);
          assert.ok(node.width>=44&&node.height>=(node.terminal?30:40),describe+`: ${node.id} was made too small to read/tap`);
        }
      }
      return layout;
    }
    async function verifyMapPainted(label){
      await settled();
      const pixels=await page.locator('#world canvas').evaluate(canvas=>{
        const context=canvas.getContext('2d'),{width,height}=canvas;
        if(!context||!width||!height)return {width,height,sampled:0,painted:0};
        const data=context.getImageData(0,0,width,height).data;
        let sampled=0,painted=0;
        const stride=Math.max(1,Math.floor(Math.sqrt(width*height/1500)));
        for(let y=0;y<height;y+=stride)for(let x=0;x<width;x+=stride){
          const i=(y*width+x)*4;sampled++;
          if(data[i+3]>0&&data[i]+data[i+1]+data[i+2]>60)painted++;
        }
        return {width,height,sampled,painted};
      });
      assert.ok(pixels.width>0&&pixels.height>0&&pixels.sampled>0,`${scenario.task} ${label}: map canvas has no pixels`);
      assert.ok(pixels.painted/pixels.sampled>.1,`${scenario.task} ${label}: map canvas is black/empty `+JSON.stringify(pixels));
    }
    async function verifyArrows(label){
      await settled();
      if(scenario.chapter===4){assert.equal(await page.locator('#flowEdges path[data-edge]').count(),0);return;}
      const paths=await page.evaluate(()=>[...document.querySelectorAll('#flowEdges path[data-edge]')].map(path=>{
        const edgeIndex=Number(path.dataset.edge),matrix=path.getScreenCTM(),length=path.getTotalLength();
        const point=distance=>{const local=path.getPointAtLength(distance),screen=new DOMPoint(local.x,local.y).matrixTransform(matrix);return {x:screen.x,y:screen.y};};
        return {edgeIndex,length,start:point(0),end:point(length)};
      }));
      assert.equal(paths.length,scenario.steps+1,`${scenario.task} ${label}: all arrows must render`);
      const nodes=await page.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
      const distance=(point,rect)=>Math.hypot(Math.max(rect.left-point.x,0,point.x-rect.right),Math.max(rect.top-point.y,0,point.y-rect.bottom));
      for(const path of paths){
        assert.ok(Number.isFinite(path.length)&&path.length>0,`${scenario.task} ${label}: empty arrow`);
        assert.ok(distance(path.start,nodes[path.edgeIndex])<=24,`${scenario.task} ${label}: arrow start detached from node `+JSON.stringify(path));
        assert.ok(distance(path.end,nodes[path.edgeIndex+1])<=24,`${scenario.task} ${label}: arrow end detached from node `+JSON.stringify(path));
      }
    }
    for(const viewport of viewports){
      await page.setViewportSize(viewport);
      const normal=await measure('normal');
      if(scenario.chapter===4){
        const coordinateLayouts=await page.locator('#flowNodes .program-block:not(.terminal)').evaluateAll(nodes=>nodes.map(node=>{
          const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
          return {node:rect(node),parts:[...node.querySelectorAll('.block-destination,[data-node-coordinate]')].map(rect)};
        }));
        for(const layout of coordinateLayouts)for(const part of layout.parts)assert.ok(part.left>=layout.node.left-1&&part.right<=layout.node.right+1&&part.top>=layout.node.top-1&&part.bottom<=layout.node.bottom+1,`delivery ${viewport.width}×${viewport.height}: destination letter and editable coordinates stay inside their block ${JSON.stringify(layout)}`);
      }
      await verifyArrows('after resize');
      const first=page.locator('#flowNodes .flow-node').nth(1);
      await first.locator('[data-grip]').tap();
      const hasInspector=scenario.chapter===1||scenario.chapter===4;
      await page.locator('#inspector').waitFor({state:hasInspector?'visible':'hidden'});
      const selected=await measure('selected');
      await verifyMapPainted('after selecting action');
      const done=page.locator('[data-edit=done]');
      if(hasInspector)assert.equal(await done.isEnabled(),true);
      if(scenario.chapter===4)assert.equal(await page.locator('#flowNodes .block-destination').count(),scenario.steps,'every delivery block retains its destination label element at each viewport');
      if(scenario.chapter===1){assert.equal(await page.locator('#inspector [data-edit=up],#inspector [data-edit=down]').count(),0,'chapter 1 reorders by dragging');await page.locator('[data-param=from]').selectOption('A');await page.locator('[data-param=to]').selectOption('C');}
      else if(scenario.chapter===4){assert.equal(await page.locator('#inspector [data-destination] option[value^=J]').count(),0);assert.equal(await page.locator('#coordinateCards [data-coordinate^=J]').count(),0);assert.deepEqual(await page.locator('#coordinateCards [data-coordinate]').evaluateAll(cards=>cards.map(card=>card.dataset.coordinate)),['W','A','B','C','D','E','F','G','H','I']);assert.doesNotMatch(await page.locator('#coordinateCards').innerText(),/\bx\b|\by\b/);await page.locator('#inspector [data-destination]').selectOption('A');assert.equal(await page.locator('#flowNodes [data-node-coordinate=x]').first().inputValue(),'4');assert.equal(await page.locator('#flowNodes [data-node-coordinate=y]').first().inputValue(),'7');await page.locator('#inspector [data-destination]').selectOption('W');assert.equal(await page.locator('#flowNodes [data-node-coordinate=y]').first().inputValue(),'1');for(const [axis,value] of [['x','10'],['y','3']]){await page.locator(`#flowNodes [data-node-coordinate=${axis}]`).first().fill(value);await page.locator(`#flowNodes [data-node-coordinate=${axis}]`).first().press('Tab');}
      }
      await measure(hasInspector?'parameter edited':'fixed action selected');
      if(output)await page.screenshot({path:join(output,`layout-${scenario.task}-${viewport.width}x${viewport.height}-editing.png`)});
      if(hasInspector)await done.tap();
      assert.equal(await page.locator('#inspector').isVisible(),false);
      await measure(hasInspector?'inspector closed':'fixed action remains visible');await verifyArrows('after touch edit');
      if(scenario.chapter===4&&((viewport.width===1280&&viewport.height===720)||(viewport.width===768&&viewport.height===1024))){
        // The classroom suite covers authentication. This layout fixture uses
        // the real notice element and classroom copy to reserve its exact space.
        await first.locator('[data-grip]').tap();
        await page.evaluate(()=>{const notice=document.querySelector('#classNotice');notice.hidden=false;notice.textContent='五年级顺序结构课堂 · 可以操作了。先画流程图，再运行、修改并提交。';});
        await measure('classroom notice and selected step');
        if(output)await page.screenshot({path:join(output,`layout-${scenario.task}-${viewport.width}x${viewport.height}-classroom-editing.png`)});
        await page.locator('[data-edit=done]').tap();
        await page.evaluate(()=>{document.querySelector('#classNotice').hidden=true;});
      }
      results.push({task:scenario.task,steps:scenario.steps,...viewport,mapShare:Number((normal.scene.width/(normal.scene.width+normal.editor.width+normal.tools.width)).toFixed(3)),flow:{height:normal.flow.clientHeight,content:normal.flow.scrollHeight},selectedFlow:{height:selected.flow.clientHeight,content:selected.flow.scrollHeight}});
      if(output)await page.screenshot({path:join(output,`layout-${scenario.task}-${viewport.width}x${viewport.height}.png`)});
    }
    // Return to landscape and exercise connections after the layout has changed
    // through every breakpoint; keep the intended graph order unchanged.
    await page.setViewportSize({width:1024,height:768});await settled();
    const originalOrder=await page.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.map(element=>element.dataset.node));
    const pair=await page.locator('#flowNodes .flow-node:not(.terminal)').evaluateAll(elements=>{
      const actions=elements.map(element=>{const r=element.getBoundingClientRect(),g=element.querySelector('[data-grip]').getBoundingClientRect();let grip;
        for(const fraction of [.5,.75,.25]){const point={x:g.left+g.width*fraction,y:g.top+g.height/2};if(document.elementFromPoint(point.x,point.y)?.closest('[data-grip]')?.dataset.grip===element.dataset.node){grip=point;break;}}
        return {id:element.dataset.node,x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,grip};
      });
      return actions.slice(0,2);
    });
    assert.equal(pair.length,2,`${scenario.task}: vertical layout offers two actions for touch drag regression`);
    assert.ok(Math.abs(pair[0].x-pair[1].x)<=1&&pair[1].y>pair[0].y,`${scenario.task}: touch reorder targets the next action below`);
    assert.ok(pair[0].grip,`${scenario.task}: another hit region covers the touch drag handle`);
    const [from,to]=pair,cdp=await context.newCDPSession(page);
    // Aim the card body into the target's explicit after half. The pointer
    // itself is offset by the left-side grip and must not stand in for its center.
    const destination={x:to.x+(from.grip.x-from.x),y:to.y+(from.grip.y-from.y)+to.height*.3};
    await page.evaluate(()=>{
      globalThis.__layoutTouchEvents=[];
      for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])document.addEventListener(type,event=>{
        globalThis.__layoutTouchEvents.push({type,x:event.clientX,y:event.clientY,kind:event.pointerType,target:event.target?.getAttribute?.('data-grip')||event.target?.className,touchAction:event.target instanceof Element?getComputedStyle(event.target).touchAction:null});
      },{capture:true});
    });
    try{
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:from.grip.x,y:from.grip.y,id:1}]});
      for(let i=1;i<=8;i++){
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.grip.x+(destination.x-from.grip.x)*i/8,y:from.grip.y+(destination.y-from.grip.y)*i/8,id:1}]});
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }finally{await cdp.detach();}
    await settled();
    const reordered=await page.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.map(element=>element.dataset.node));
    const expectedOrder=[...originalOrder],sourceIndex=expectedOrder.indexOf(from.id),targetIndex=expectedOrder.indexOf(to.id);
    expectedOrder.splice(sourceIndex,1);expectedOrder.splice(targetIndex,0,from.id);
    assert.deepEqual(reordered,scenario.chapter===2?expectedOrder.filter(id=>id!==originalOrder[0]&&id!==originalOrder.at(-1)):expectedOrder,`${scenario.task}: touch handle drag into the explicit after half must reorder; ${JSON.stringify(await page.evaluate(()=>globalThis.__layoutTouchEvents))}`);
    await page.waitForTimeout(550);
    await page.locator('#undoButton').tap();
    assert.deepEqual(await page.locator('#flowNodes .flow-node').evaluateAll(elements=>elements.map(element=>element.dataset.node)),originalOrder,`${scenario.task}: undo restores drag order`);
    const doneAfterDrag=page.locator('[data-edit=done]');
    if(await doneAfterDrag.isVisible())await doneAfterDrag.tap();
    if(scenario.chapter!==4&&scenario.chapter!==2){
    await page.locator('#connectButton').tap();
    const portHits=await page.locator('#flowNodes .flow-node').evaluateAll(nodes=>nodes.slice(0,3).flatMap(node=>[...node.querySelectorAll('[data-port]')].map(port=>{
      const r=port.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return {node:node.dataset.node,port:port.dataset.port,side:port.dataset.side,hit:hit===port};
    })));
    for(const port of portHits){assert.equal(port.hit,true,`${scenario.task}: ${port.node} ${port.port} port has an unobstructed touch target`);assert.equal(port.side,port.port==='in'?'top':'bottom',`${scenario.task}: single-column ports face vertically`);}
    await page.locator('#flowNodes .flow-node').nth(0).locator('[data-port=out]').tap();
    await page.locator('#flowNodes .flow-node').nth(1).locator('[data-port=in]').tap();
    await page.locator('#connectButton').tap();
    await measure('manual connection after resize');
    // Reconnecting moves this edge to the end of the edge array, so return to
    // canonical order through the student's own automatic connection control.
    await page.locator('#chainButton').tap();await verifyArrows('manual connection repaired');
    }
    assert.equal(await page.locator('#runButton').isEnabled(),true);
    await context.close();
  }
  const teacherContext=await browser.newContext({viewport:viewports[0]});
  await configureContext(teacherContext);
  const teacher=await teacherContext.newPage();teacher.on('pageerror',error=>errors.push(error.message));
  await teacher.goto(origin+'/teacher.html');await teacher.locator('#login-dialog').waitFor();
  await teacher.locator('#key').fill('isolated-layout-test');await teacher.locator('#login-form button').click();
  await teacher.locator('#login-dialog').waitFor({state:'hidden'});
  for(const viewport of [viewports[0],viewports[4],viewports[5]]){
    await teacher.setViewportSize(viewport);
    const dimensions=await teacher.evaluate(()=>({height:document.body.getBoundingClientRect().height,shell:document.querySelector('.app-shell').getBoundingClientRect().height,footer:document.querySelector('.site-footer').getBoundingClientRect().bottom,viewport:innerHeight}));
    assert.equal(dimensions.height,viewport.height,'teacher body fills viewport');
    assert.ok(dimensions.shell>viewport.height*.8,'teacher workspace does not collapse');
    assert.ok(Math.abs(dimensions.footer-dimensions.viewport)<=1,'teacher registration remains at viewport bottom');
  }
  await teacherContext.close();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,css:legacyCss?'Chromium 99 unsupported CSS removed':'native',scenarios:new Set(results.map(result=>result.task)).size,layouts:results.length,results,pageErrors:errors},null,2));
}finally{
  await browser?.close();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  rmSync(dataDir,{recursive:true,force:true});
}
