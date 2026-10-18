import {CHAPTERS,TASKS,DELIVERY_MAP,DELIVERY_RULES_VERSION,deliveryRulesVersion,initialState,availableActions,validateGraph,simulate,exampleGraph,actionLabel,deliveryPointId,normalizeDeliveryGraph,normalizeDeliveryResult} from '/shared/engine.mjs';
import {SupermarketWorld} from './world.js';
import * as db from './db.js';
import {dragFootprint,dropZone,insertionAt,movedInsertionIndex} from './drag-drop.mjs';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const copy=v=>structuredClone(v), uid=()=>globalThis.crypto?.randomUUID?.()||`s-${Date.now().toString(36)}-${Array.from(globalThis.crypto?.getRandomValues?.(new Uint32Array(3))||[Math.random()*1e9,Math.random()*1e9]).map(n=>n.toString(36)).join('')}`, esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaultTask=ch=>['','drink-swap','fresh-juice','tea','delivery'][ch];
const state={chapter:1,taskId:'drink-swap',graph:null,selected:null,undo:[],session:null,learner:null,assignment:null,online:navigator.onLine,stream:null,runs:[],feedback:[],queue:[],syncing:false,conflict:null,running:null,runEpoch:0,userPaused:false,teacherPaused:false,connecting:false,connectFrom:null,activeNode:null,errorNode:null,demo:false,tabBlocked:false,submittedFingerprint:null,authExpired:false,joining:false,checkingClass:true,classUnavailable:false,switchingTask:false};
let saveTimer,toastTimer,transitionTimer,heartbeat,channel,identityToken=uid(),leaseTimer,classTimer,deviceToken,linkedSessionId;
const scope=()=>state.learner?.id||'practice';
const graphKey=(ch=state.chapter,task=state.taskId)=>`draft:${scope()}:${ch}:${task}`;
const metaKey=(key)=>`meta:${key}`;
const task=()=>TASKS.find(t=>t.id===state.taskId);
const isDelivery=()=>state.chapter===4;
let dragClickUntil=0,cancelCardDrag=null,dragPreview=null,dragLayoutBase=null;
const DRAG_SCALE=.92;
const flowMotions=new Map();
let flowMotionFrame=0;
const deliveryDestinations=()=>Object.entries(DELIVERY_MAP.points).filter(([id])=>!id.startsWith('J'));
const allowed=()=>!state.joining&&!state.checkingClass&&!state.switchingTask&&!state.classUnavailable&&!state.authExpired&&!state.tabBlocked&&(!state.session||state.session.phase==='practice');
const editable=()=>allowed()&&!state.running&&!state.demo;
const cleanGraph=(ch=state.chapter,t=state.taskId)=>({schemaVersion:1,chapterId:ch,taskId:t,contentVersion:'1.0.0',...(t==='delivery'?{deliveryCoordinates:'cartesian-y-up',deliveryRulesVersion:DELIVERY_RULES_VERSION}:{}),revision:0,nodes:[{id:uid(),kind:'start'},{id:uid(),kind:'end'}],edges:[]});
const currentDeliveryDraft=graph=>{const normalized=normalizeDeliveryGraph(graph);return normalized?.taskId==='delivery'&&deliveryRulesVersion(normalized)!==DELIVERY_RULES_VERSION?{...normalized,deliveryRulesVersion:DELIVERY_RULES_VERSION}:normalized;};
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4000);}
function storageError(e){$('#saveStatus').textContent=e.message||'设备存储不可用';$('#saveStatus').style.color='#ad6c43';toast(e.message||'设备存储不可用，请保留此页面');}
async function safeSet(key,value){try{await db.set(key,value);return true;}catch(e){storageError(e);return false;}}
async function api(path,options={}){
  const learnerHeader=state.learner&&/^\/api\/student\/(ack|drafts|runs|submissions|works|task)(?:\/|$)/.test(path)?{'X-Supermarket-Learner':state.learner.id}:{};
  let response;try{response=await fetch(path,{credentials:'same-origin',signal:AbortSignal.timeout(10000),...options,headers:{'Content-Type':'application/json','X-Supermarket-Role':'student',...learnerHeader,...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body)});}catch(e){state.online=false;renderConnection();throw e;}
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||data.message||'请求未完成');Object.assign(error,{status:response.status,data});throw error;}
  state.online=true;renderConnection();return data;
}
function snapshot(){return copy(state.graph);}
function chain(){state.graph.edges=state.graph.nodes.slice(1).map((n,i)=>({from:state.graph.nodes[i].id,to:n.id}));}
function beforeEdit(){if(!editable())return false;state.undo.push(snapshot());if(state.undo.length>35)state.undo.shift();state.errorNode=null;state.activeNode=null;return true;}
function changed(){renderGraph();scheduleSave();$('#result').hidden=true;updateControls();}
function scheduleSave(){clearTimeout(saveTimer);const key=graphKey(),graph=snapshot();safeSet(key,{graph,updatedAt:Date.now()}).then(ok=>{if(ok)$('#saveStatus').textContent=state.submittedFingerprint&&state.submittedFingerprint!==fingerprint(graph)?'新草稿已保存 · 需重新提交':state.learner?'已存此设备 · 等待同步':'已保存在此设备';});saveTimer=setTimeout(()=>enqueue({kind:'draft',key,graph}),650);}
async function persistNow({kind='draft',run,submission}={}){clearTimeout(saveTimer);const key=graphKey(),graph=snapshot();await safeSet(key,{graph,updatedAt:Date.now()});return enqueue({kind,key,graph,run,submission});}

const learnerCode=()=>state.learner?.autoCode||state.learner?.seat||state.learner?.name||'';
function renderConnection(){
  const el=$('#connection'),button=$('#accountButton'),code=learnerCode();
  el.classList.toggle('offline',!state.online);
  el.textContent=state.joining||state.checkingClass?'正在连接':state.learner?(state.authExpired?'正在恢复连接':!state.online?'离线保存中':state.session?.phase==='ended'?'课堂已结束':state.classUnavailable?'等待开课':'课堂已连接'):(state.online?'等待开课':'离线体验');
  button.textContent=code||'重新连接';button.disabled=state.joining||state.checkingClass;
  button.classList.toggle('student-badge',!!code);button.setAttribute('aria-label',code?`学生编号 ${code}，查看工牌`:'重新连接当前课堂');
  button.title=code?`学生编号 ${code}`:'老师开课后会自动加入，无需填写信息';
  $('#playerName').textContent=code||'小店员';
}
function renderChapter(){
  const chapter=CHAPTERS.find(c=>c.id===state.chapter),t=task(),delivery=isDelivery();
  document.body.classList.toggle('delivery-mode',delivery);
  $('#chapters').innerHTML=CHAPTERS.map(c=>`<button class="chapter-tab ${c.id===state.chapter?'active':''}" data-chapter="${c.id}" ${state.session||state.running?'disabled':''}><b>0${c.id}</b><span>${esc(['','饮料区','水果区','实践区','配送区'][c.id])}</span></button>`).join('');
  $('#chapterNumber').textContent=`第${['','一','二','三','四'][state.chapter]}站 / 0${state.chapter}`;$('#sceneTitle').textContent=chapter.title;$('#npcName').textContent=t.npc;$('#dialogueText').textContent=chapter.story;
  $('#taskGoal').textContent=t.goal;$('#metrics').hidden=!delivery;$('#deliveryOrders').hidden=!delivery;$('#coordinateTools').hidden=!delivery;
  renderPracticeTasks();
  $('#editorTitle').textContent=delivery?'我的配送程序':'安排我的工作';$('#runButton').textContent=delivery?'▶ 运行配送程序':'▶ 运行流程图';
  $('#toolHint').textContent=delivery?'拖动蓝色积木到画布，按顺序拼接。':'把操作卡拖入画布；拖回工具区可以删除。';
  $('#paletteHint').textContent=delivery?'拖动蓝色积木到画布':'拖动蓝色卡片到画布';
  $('#executionHint').textContent=delivery?'从上到下，依次执行配送积木':'按箭头顺序，一步一步执行';
  $('#structureHelp').textContent=delivery?'把移动积木依次拼接。每块沿横向或纵向道路直走；转弯要再加一块。途经地址会自动交付。点地图探路不计入成绩。':'圆角框表示开始和结束，方框写操作，箭头表示执行顺序。点地面探路不会改变任务结果。';
  $('#connectButton').hidden=delivery;$('#chainButton').hidden=delivery;$('#demoButton').textContent=delivery?'看配送示范':'看师傅示范';
  $('#flowEmpty').innerHTML=delivery?'把右边的蓝色积木拖进来<br><small>先看坐标，再决定配送顺序</small>':'从右边拖入一个操作<br><small>再调整顺序，连接成完整的流程图</small>';
  $('#rules').innerHTML=delivery?'<p>六单在出发时全部取好，A、E含冷藏商品，D是普通饼干订单。必须优先留意送达时限。走一格1任务分钟，每单交付2分钟。到达时刻不超过时限才成功，越早送达奖励越多；超时变质会扣金币。</p><p>每块积木沿一条直路移动，转弯需要新的坐标积木。思考、动画快进和暂停不计任务时间。把六单都处理完，再比较用时与金币。</p>':`<p>${esc(t.description)}</p>`;
  const actions=availableActions(state.chapter,state.taskId),mixed=actions.length>3?[actions[2],actions[0],actions[4],actions[1],actions[3]]:actions;
  $('#actionCards').innerHTML=mixed.filter(Boolean).map(a=>`<button class="action-card ${delivery?'block-palette':''}" data-action="${a.actionId}" data-palette-drag="${a.actionId}">${delivery?'⠿ 移动到（ , ）':`＋ ${esc(a.label)}`}</button>`).join('');
  $('#coordinateCards').innerHTML=delivery?deliveryDestinations().map(([id,point])=>`<button class="coordinate-card ${DELIVERY_MAP.orders.some(o=>o.point===id&&o.cold)?'cold-coordinate':''} ${/^[G-I]$/.test(id)?'waypoint-coordinate':''}" data-coordinate="${id}" data-palette-drag="move_to" data-x="${point.x}" data-y="${point.y}" aria-label="${esc(id)}${/^[G-I]$/.test(id)?'转弯点':''}（${point.x},${point.y}）"><b>${esc(id)}（${point.x},${point.y}）</b></button>`).join(''):'';
  renderConnection();renderGraph();renderComparison();renderNotice();updateControls();
}
function renderNotice(){
  const s=state.session,el=$('#classNotice');el.hidden=!s&&!state.tabBlocked;
  if(state.joining){el.hidden=false;el.textContent='正在领取工牌、连接老师的课堂…';return;}
  if(state.authExpired){el.hidden=false;el.textContent='正在重新连接课堂，本机作品已保留。换设备时，可点右上角工牌，用老师的恢复码找回作品。';return;}
  if(state.tabBlocked){el.hidden=false;el.textContent='此课堂已在另一个标签页打开。请使用原标签页操作，本页可以查看作品。';return;}
  if(state.classUnavailable){el.hidden=false;el.textContent='请等待老师开课。原课堂作品已保留，可以查看实践记录。';return;}
  if(!s)return;
  const labels={waiting:'请等待老师开始。',explain:'请先听老师讲解，开放操作后再安排流程图。',practice:'可以操作了。先画流程图，再运行、修改并提交。',paused:'老师已暂停全班操作，请抬头交流。',ended:'本次课堂已结束，作品已经保留，可以查看实践记录。'};
  el.textContent=`${s.name} · ${labels[s.phase]||''}${!state.online?' 当前离线，作品会先保存在此设备。':''}`;
}
function updateControls(){
  const edit=editable(),running=!!state.running||state.demo;
  if(!edit)cancelCardDrag?.();
  if(!allowed()&&$('#submitDialog').open)$('#submitDialog').close();
  $('#runButton').disabled=!edit;$('#submitButton').disabled=!edit;$('#clearButton').disabled=!edit;$('#chainButton').disabled=!edit;$('#connectButton').disabled=!edit;$('#undoButton').disabled=!edit||!state.undo.length;
  $$('#practiceTasks button').forEach(button=>button.disabled=!edit);
  $$('.action-card').forEach(e=>e.disabled=!edit);$$('.chapter-tab').forEach(e=>e.disabled=!!state.session||running||state.joining||state.checkingClass);$('#pauseButton').disabled=!running||state.teacherPaused;$('#pauseButton').textContent=state.userPaused?'继续':'暂停';$('#stopButton').disabled=!running;$('#demoButton').disabled=running||state.tabBlocked||state.joining||state.checkingClass||state.switchingTask||state.classUnavailable||!!state.session&&['waiting','paused','ended'].includes(state.session.phase);
  $('#flowCanvas').classList.toggle('read-only',!edit);$('#connectButton').classList.toggle('active',state.connecting);$('#flowCanvas').classList.toggle('connecting',state.connecting);requestGraphLayout();
  updateConnectionTargets();
  world.setMode(running?'run':allowed()?'explore':'locked');$('#mapHint').textContent=running?(state.demo?'正在观看示范':isDelivery()?'正在执行配送积木':'正在按流程图行动'):isDelivery()?'底部查坐标 · 点道路可探路':state.chapter===3?'点工作台选任务 · 各区作品分别保存':'点地面走动 · 点师傅听提示';
  $$('#coordinateCards button, #flowNodes input').forEach(el=>el.disabled=!edit);
  $('#chapters').querySelectorAll('button').forEach(b=>b.disabled=!!state.session||running||state.switchingTask);
  renderInspector();
}
function renderGraph(){
  stopFlowMotion();
  if(isDelivery()){renderProgram();return;}
  $('#flowCanvas').classList.remove('program-canvas');
  const nodes=state.graph.nodes;$('#flowEmpty').hidden=nodes.some(n=>n.kind==='action');
  $('#flowNodes').innerHTML=nodes.map((n,index)=>`<div class="flow-node ${n.kind!=='action'?'terminal':''} ${state.selected===n.id?'selected':''} ${state.activeNode===n.id?'executing':''} ${state.errorNode===n.id?'failed':''}" data-node="${n.id}" tabindex="0" role="button" aria-label="${esc(n.label||actionLabel(n.kind==='action'?n:{actionId:n.kind}))}">${n.kind!=='start'?`<button class="port in" data-port="in" data-id="${n.id}" aria-label="连接到这一步"></button>`:''}${n.kind==='action'?`<span class="node-grip" data-grip="${n.id}" role="button" aria-label="拖动排序">⠿</span><div class="node-copy"><strong>${esc(n.label||actionLabel(n))}</strong>${n.label?`<small>${esc(actionLabel(n))}</small>`:''}</div><span class="node-number">${String(index).padStart(2,'0')}</span>`:n.kind==='start'?'开始':'结束'}${n.kind!=='end'?`<button class="port out" data-port="out" data-id="${n.id}" aria-label="从这一步连出"></button>`:''}</div>`).join('');
  updateConnectionTargets();
  requestGraphLayout();renderInspector();
}
function updateConnectionTargets(){
  // Chrome can redirect a touch on a drag grip to a nearby native button. Keep
  // connector targets inactive until the student explicitly enters link mode.
  $$('#flowNodes .port').forEach(port=>{port.style.pointerEvents=state.connecting?'auto':'none';});
}
let graphLayoutFrame=0;
const stackedLayout=()=>matchMedia('(max-width:820px) and (orientation:portrait), (max-width:700px)').matches;
function placeInspector(){
  const inspector=$('#inspector'),parent=$('.control-content');
  if(inspector.parentElement!==parent)parent.prepend(inspector);
  const details=$('.scene-bottom'),detailsParent=isDelivery()&&stackedLayout()?$('#sceneDetailsSlot'):$('.scene-panel');
  if(details.parentElement!==detailsParent)detailsParent.append(details);
}
function renderProgram(){
  $('#flowCanvas').classList.add('program-canvas');$('#flowEdges').innerHTML='';
  $('#flowEmpty').hidden=state.graph.nodes.some(n=>n.kind==='action');
  $('#flowNodes').innerHTML=state.graph.nodes.map((n,index)=>`<div class="flow-node program-block ${n.kind!=='action'?'terminal block-'+n.kind:''} ${state.selected===n.id?'selected':''} ${state.activeNode===n.id?'executing':''} ${state.errorNode===n.id?'failed':''}" data-node="${n.id}" tabindex="0" role="group" aria-label="${esc(actionLabel(n.kind==='action'?n:{actionId:n.kind}))}">${programNodeContent(n,index)}</div>`).join('');
  requestGraphLayout();renderInspector();
}
function programNodeContent(n,index){
  if(n.kind!=='action')return n.kind==='start'?'▶ 当点击运行':'配送程序结束';
  return `<span class="node-grip" data-grip="${n.id||''}" role="button" aria-label="拖动积木排序">⠿</span><div class="block-copy"><span>移动到</span><span class="block-coordinate"><b class="block-destination">${esc(deliveryPointId(n.params))}</b>（<input type="number" inputmode="numeric" step="1" value="${esc(n.params?.x??10)}" data-node-coordinate="x" aria-label="第${index}块横坐标" ${editable()?'':'disabled'}><span>，</span><input type="number" inputmode="numeric" step="1" value="${esc(n.params?.y??3)}" data-node-coordinate="y" aria-label="第${index}块纵坐标" ${editable()?'':'disabled'}>）</span></div><span class="node-number">${index}</span>`;
}
function paletteCanvasGhost(actionId,params){
  const action=availableActions(state.chapter,state.taskId).find(a=>a.actionId===actionId);
  const node={kind:'action',actionId,params:params||action?.params},el=document.createElement('div');
  el.className=`flow-node${isDelivery()?' program-block':''}`;
  el.innerHTML=isDelivery()?programNodeContent(node,''):`<span class="node-grip">⠿</span><div class="node-copy"><strong>${esc(actionLabel(node))}</strong></div>`;
  return el;
}
function layoutProgram(width,height,nodes){
  layoutVerticalNodes(width,height,nodes,{sizes:[[44,34,8],[42,34,6],[42,32,4]],maxWidth:390,program:true});
}
function layoutVerticalNodes(width,height,nodes,{sizes,maxWidth,program=false}){
  // Compact the cards and their seams to fit a standard task. Longer programs
  // keep the smallest readable size and scroll inside the same vertical chain.
  let choice;
  for(const [actionHeight,terminalHeight,gap] of sizes){
    const needed=nodes.reduce((sum,node)=>sum+(node.classList.contains('terminal')?terminalHeight:actionHeight),0)+Math.max(0,nodes.length-1)*gap+12;
    choice={actionHeight,terminalHeight,gap,needed};
    if(needed<=height)break;
  }
  const {actionHeight,terminalHeight,gap,needed}=choice,viewport=$('#flowScroll');
  const nodeWidth=Math.min(maxWidth,width),fitted=needed<=height;
  $('#flowCanvas').style.height=`${Math.max(height,needed)}px`;
  viewport.classList.toggle('flow-fitted',fitted);
  $('#flowNodes').dataset.columns='1';
  if(fitted){viewport.scrollTop=0;viewport.scrollLeft=0;}
  let top=6;
  nodes.forEach(node=>{
    const terminal=node.classList.contains('terminal'),w=terminal&&!program?Math.min(110,nodeWidth):nodeWidth,h=terminal?terminalHeight:actionHeight;
    Object.assign(node.style,{left:`${(width-w)/2}px`,top:`${top}px`,width:`${w}px`,height:`${h}px`});
    node.style.setProperty('--flow-node-height',`${h}px`);
    node.classList.toggle('compact-block',program&&w<260);
    top+=h+gap;
  });
}
function requestGraphLayout(){
  cancelAnimationFrame(graphLayoutFrame);
  graphLayoutFrame=requestAnimationFrame(drawEdges);
}
function layoutGraph(){
  placeInspector();
  const viewport=$('#flowScroll'),style=getComputedStyle(viewport);
  const width=Math.max(100,viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
  const height=Math.max(70,viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom));
  const nodes=dragPreview?.order||$$('#flowNodes .flow-node');
  if(!nodes.length)return;
  if(isDelivery()){layoutProgram(width,height,nodes);return;}
  layoutVerticalNodes(width,height,nodes,{sizes:[[56,36,24],[48,34,18],[44,32,12],[44,32,8]],maxWidth:320});
  orientFlowPorts(nodes);
}
function orientFlowPorts(nodes){
  const sideTo=(from,to)=>{
    const a=from.getBoundingClientRect(),b=to.getBoundingClientRect();
    return b.top+b.height/2>=a.top+a.height/2?'bottom':'top';
  };
  nodes.forEach((node,index)=>{
    const id=node.dataset.node,incoming=state.graph.edges.find(e=>e.to===id),outgoing=state.graph.edges.find(e=>e.from===id);
    const previous=nodes.find(n=>n.dataset.node===incoming?.from)||nodes[index-1],next=nodes.find(n=>n.dataset.node===outgoing?.to)||nodes[index+1];
    const input=node.querySelector('[data-port=in]'),output=node.querySelector('[data-port=out]');
    if(input)input.dataset.side=previous?sideTo(node,previous):'top';
    if(output)output.dataset.side=next?sideTo(node,next):'bottom';
  });
}
function drawEdges(){
  if(!state.graph)return;
  layoutGraph();
  paintEdges();
}
function paintEdges(){
  if(!state.graph)return;
  if(isDelivery()){$('#flowEdges').innerHTML='';return;}
  orientFlowPorts($$('#flowNodes .flow-node'));
  const svg=$('#flowEdges'),box=$('#flowCanvas').getBoundingClientRect();
  const anchor=(node,port)=>{
    const r=node.getBoundingClientRect(),side=node.querySelector(`[data-port=${port}]`)?.dataset.side||'bottom';
    return {x:r.left+r.width/2-box.left,y:(side==='top'?r.top-1:r.bottom+1)-box.top};
  };
  svg.innerHTML=`<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#4d7858"/></marker></defs>`+state.graph.edges.map((edge,i)=>{
    const a=$(`[data-node="${edge.from}"]`),b=$(`[data-node="${edge.to}"]`);if(!a||!b)return '';
    const p=anchor(a,'out'),q=anchor(b,'in'),path=`M${p.x},${p.y} L${q.x},${q.y}`;
    return `<path data-edge="${i}" class="flow-edge" d="${path}" marker-end="url(#arrow)"/>`;
  }).join('');
}
function captureFlowLayout(){
  return new Map($$('#flowNodes .flow-node:not(.being-dragged)').map(node=>[node.dataset.node,node.getBoundingClientRect()]));
}
function stopFlowMotion(){
  cancelAnimationFrame(flowMotionFrame);flowMotionFrame=0;
  for(const [node,motion] of flowMotions){motion.onfinish=null;motion.cancel();node.classList.remove('flow-shifting');}
  flowMotions.clear();$('#flowCanvas')?.classList.remove('layout-in-motion');
}
function animateFlowLayout(before){
  if(matchMedia('(prefers-reduced-motion:reduce)').matches)return;
  const canvas=$('#flowCanvas');
  for(const node of $$('#flowNodes .flow-node:not(.being-dragged)')){
    const previous=before.get(node.dataset.node),next=node.getBoundingClientRect();
    if(!previous||!next.width||!next.height)continue;
    const dx=previous.left-next.left,dy=previous.top-next.top,sx=previous.width/next.width,sy=previous.height/next.height;
    if(Math.abs(dx)<.25&&Math.abs(dy)<.25&&Math.abs(sx-1)<.002&&Math.abs(sy-1)<.002)continue;
    // Start from the current visible position, including any unfinished motion.
    // A tiny overshoot gives the cards some spring without a large bounce.
    const rebound=delta=>-Math.sign(delta)*Math.min(Math.abs(delta)*.035,2);
    node.classList.add('flow-shifting');
    const motion=node.animate([
      {translate:`${dx}px ${dy}px`,scale:`${sx} ${sy}`,easing:'cubic-bezier(.18,.8,.26,1)'},
      {translate:`${rebound(dx)}px ${rebound(dy)}px`,scale:'1 1',offset:.72,easing:'ease-out'},
      {translate:'0px 0px',scale:'1 1'}
    ],{duration:280});
    flowMotions.set(node,motion);
    motion.onfinish=()=>{
      if(flowMotions.get(node)!==motion)return;
      flowMotions.delete(node);node.classList.remove('flow-shifting');
      if(!flowMotions.size)canvas.classList.remove('layout-in-motion');
    };
  }
  if(!flowMotions.size)return;
  canvas.classList.add('layout-in-motion');
  const follow=()=>{flowMotionFrame=0;paintEdges();if(flowMotions.size)flowMotionFrame=requestAnimationFrame(follow);};
  follow();
}
function renderInspector(){
  const n=state.graph?.nodes.find(n=>n.id===state.selected),el=$('#inspector');el.hidden=!n||n.kind!=='action';if(el.hidden)return;
  const disabled=!editable()?'disabled':'';let params='';
  if(n.actionId==='move_crate')params=`<div class="inspector-row crate-params"><label for="crateFrom">搬出柜位<select id="crateFrom" data-param="from" ${disabled}>${['A','B','C'].map(v=>`<option ${n.params.from===v?'selected':''}>${v}</option>`).join('')}</select></label><label for="crateTo">→ 放入柜位<select id="crateTo" data-param="to" ${disabled}>${['A','B','C'].map(v=>`<option ${n.params.to===v?'selected':''}>${v}</option>`).join('')}</select></label></div>`;
  if(n.actionId==='move_to')params=`<div class="inspector-row"><label>地图位置</label><select data-destination ${disabled}><option value="">手动填写坐标</option>${deliveryDestinations().map(([id,p])=>`<option value="${id}" ${n.params?.x===p.x&&n.params?.y===p.y?'selected':''}>${id}（${p.x},${p.y}）</option>`).join('')}</select></div>`;
  el.innerHTML=`<div class="inspector-row"><label for="nodeLabel">步骤文字（可修改）</label><input id="nodeLabel" type="text" maxlength="50" value="${esc(n.label||'')}" placeholder="${esc(actionLabel(n))}" ${disabled}></div>${params}<div class="move-buttons"><button class="secondary" data-edit="up" ${disabled}>↑ 上移</button><button class="secondary" data-edit="down" ${disabled}>↓ 下移</button><button class="quiet" data-edit="delete" ${disabled}>删除</button><button class="secondary" data-edit="done">完成</button></div>`;
}
function revealNode(id){if(!$('#flowScroll').classList.contains('flow-fitted'))$(`[data-node="${id}"]`)?.scrollIntoView({block:'nearest',behavior:'smooth'});}
function addAction(id,params=null,index=null){
  const limit=isDelivery()?48:24;if(state.graph.nodes.length>=limit)return toast(`最多${limit-2}个操作，请先精简步骤`);if(!beforeEdit())return;
  const a=availableActions(state.chapter,state.taskId).find(a=>a.actionId===id);if(!a){state.undo.pop();return;}
  const n={id:uid(),kind:'action',actionId:id,...(params||a.params?{params:copy(params||a.params)}:{})};
  state.graph.nodes.splice(index===null?state.graph.nodes.length-1:Math.max(1,Math.min(index,state.graph.nodes.length-1)),0,n);state.selected=isDelivery()?null:n.id;chain();changed();requestAnimationFrame(()=>revealNode(n.id));return n.id;
}
function moveNode(id,direction){const index=state.graph.nodes.findIndex(n=>n.id===id),target=index+direction;if(index<1||target<1||target>state.graph.nodes.length-2)return;if(!beforeEdit())return;[state.graph.nodes[index],state.graph.nodes[target]]=[state.graph.nodes[target],state.graph.nodes[index]];chain();changed();}
function selectNode(id){if(state.connecting){const n=state.graph.nodes.find(n=>n.id===id);if(!state.connectFrom&&n.kind!=='end'){state.connectFrom=id;toast('再点要连接到的步骤');}else if(state.connectFrom&&n.kind!=='start'){connectNodes(state.connectFrom,id);state.connectFrom=null;}return;}state.selected=state.selected===id?null:id;renderGraph();}
function connectNodes(from,to){if(from===to)return toast('请连接两个不同的步骤框');if(!beforeEdit())return;state.graph.edges=state.graph.edges.filter(e=>e.from!==from&&e.to!==to);state.graph.edges.push({from,to});changed();}
$('#flowNodes').addEventListener('click',e=>{if(Date.now()<dragClickUntil||e.target.closest('input,label'))return;const port=e.target.closest('[data-port]');if(port){e.stopPropagation();if(!editable())return;if(!state.connecting){selectNode(port.dataset.id);return;}if(port.dataset.port==='out'){state.connectFrom=port.dataset.id;toast('点下一步的连接点，画出箭头');}else if(state.connectFrom){connectNodes(state.connectFrom,port.dataset.id);state.connectFrom=null;}updateControls();return;}const n=e.target.closest('[data-node]');if(n)selectNode(n.dataset.node);});
$('#flowNodes').addEventListener('keydown',e=>{if(e.target.closest('input'))return;if(['Enter',' '].includes(e.key)&&e.target.matches('[data-node]')){e.preventDefault();selectNode(e.target.dataset.node);}});
$('#flowEdges').addEventListener('click',e=>{if(e.target.dataset.edge!==undefined&&beforeEdit()){state.graph.edges.splice(Number(e.target.dataset.edge),1);changed();toast('连线已删除，可以重新连接');}});
// Keep capture on a stable element: committing an input can replace every card.
function beginCardDrag(event,{getSource,getCanvasGhost,onStart,onMove,onDrop,onTap,onCleanup}){
  if(cancelCardDrag||event.isPrimary===false)return;
  event.preventDefault();
  const active=document.activeElement;
  if(active?.matches('input,select,textarea')&&active.closest('#inspector,#flowNodes'))active.blur();
  if(!editable())return;
  stopFlowMotion();
  $$('.snap-landed').forEach(el=>el.classList.remove('snap-landed'));
  drawEdges();
  const source=getSource();if(!source)return;
  const rect=source.getBoundingClientRect(),pointerId=event.pointerId,capture=document.documentElement;
  const origin={x:event.clientX,y:event.clientY},offset={x:event.clientX-rect.left,y:event.clientY-rect.top};
  // Keep insertion decisions anchored to the original layout while the cards
  // make room for the preview. Scrolling still follows the current canvas.
  const canvasRect=$('#flowCanvas').getBoundingClientRect();
  dragLayoutBase=$$('#flowNodes .flow-node').map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.node,left:r.left-canvasRect.left,top:r.top-canvasRect.top,width:r.width,height:r.height};});
  let point={...origin},dragged=false,ghost=null,freeGhost=null,canvasGhost=null,frame=0,finished=false;
  const footprint=position=>dragFootprint(position,{x:offset.x*DRAG_SCALE,y:offset.y*DRAG_SCALE},{width:rect.width*DRAG_SCALE,height:rect.height*DRAG_SCALE});
  const createGhost=(template,copyStyle=false)=>{
    const el=template.cloneNode(true);el.classList.add('drag-ghost');el.inert=true;el.setAttribute('aria-hidden','true');
    for(const child of [el,...el.querySelectorAll('*')])for(const attribute of [...child.attributes])if(attribute.name==='id'||attribute.name.startsWith('data-'))child.removeAttribute(attribute.name);
    if(copyStyle){const style=getComputedStyle(template);for(const property of ['background-color','border-color','border-width','border-style','border-radius','color','font-family','font-size','font-weight','line-height','padding','display','align-items','justify-content','gap'])el.style.setProperty(property,style.getPropertyValue(property));}
    return el;
  };
  const paint=()=>{
    frame=0;if(!ghost)return;
    const body=footprint(point),snap=onMove?.(point,body);
    if(snap&&!canvasGhost)canvasGhost=getCanvasGhost?createGhost(getCanvasGhost()):freeGhost;
    const next=snap?canvasGhost:freeGhost;
    if(next!==ghost){ghost.remove();ghost=next;document.body.append(ghost);}
    ghost.style.setProperty('--drag-width',`${snap?.width??rect.width}px`);ghost.style.setProperty('--drag-height',`${snap?.height??rect.height}px`);
    ghost.style.setProperty('--flow-node-height',`${snap?.height??rect.height}px`);
    ghost.classList.toggle('compact-block',snap?snap.width<260:source.classList.contains('compact-block'));
    ghost.classList.toggle('is-snapped',!!snap);
    if(snap)ghost.dataset.snapSide=snap.side;else delete ghost.dataset.snapSide;
    ghost.style.transform=`translate3d(${snap?.left??body.left}px,${snap?.top??body.top}px,0) scale(${snap?.scale??DRAG_SCALE})`;
  };
  const move=e=>{
    if(e.pointerId!==pointerId)return;
    point={x:e.clientX,y:e.clientY};
    if(!dragged&&Math.hypot(point.x-origin.x,point.y-origin.y)<7)return;
    e.preventDefault();
    if(!dragged){
      dragged=true;window.getSelection()?.removeAllRanges();
      ghost=freeGhost=createGhost(source,true);
      ghost.style.setProperty('--drag-width',`${rect.width}px`);ghost.style.setProperty('--drag-height',`${rect.height}px`);
      document.body.append(ghost);source.classList.add('being-dragged');document.body.classList.add('card-dragging');onStart?.();
      paint();
    }
    if(!frame)frame=requestAnimationFrame(paint);
  };
  const finish=e=>{
    if(finished||e.pointerId!==undefined&&e.pointerId!==pointerId)return;
    finished=true;cancelAnimationFrame(frame);
    document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',finish,true);document.removeEventListener('pointercancel',finish,true);
    capture.removeEventListener('lostpointercapture',lostCapture);window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',hidden);
    if(capture.hasPointerCapture(pointerId))capture.releasePointerCapture(pointerId);
    const releaseLayout=captureFlowLayout();
    ghost?.remove();source.classList.remove('being-dragged');getSource()?.classList.remove('being-dragged');
    document.body.classList.remove('card-dragging');cancelCardDrag=null;
    dragClickUntil=Date.now()+500;
    try{
      if(e.type!=='pointerup'||!editable())return;
      if(dragged){const released={x:e.clientX,y:e.clientY};onDrop?.(released,footprint(released));}else onTap?.();
    }finally{onCleanup?.(releaseLayout);dragLayoutBase=null;}
  };
  const cancel=()=>finish({type:'cancel',pointerId});
  const lostCapture=e=>{if(e.pointerId===pointerId)cancel();};
  const hidden=()=>{if(document.hidden)cancel();};
  cancelCardDrag=cancel;
  document.addEventListener('pointermove',move,{capture:true,passive:false});document.addEventListener('pointerup',finish,true);document.addEventListener('pointercancel',finish,true);
  capture.addEventListener('lostpointercapture',lostCapture);window.addEventListener('blur',cancel);document.addEventListener('visibilitychange',hidden);
  capture.setPointerCapture(pointerId);
}
function cardDropTarget(point,footprint,sourceId=null,previous=null){
  const zone=dropZone(footprint,$('.editor-panel').getBoundingClientRect(),$('.control-panel').getBoundingClientRect());
  const canvas=$('#flowCanvas').getBoundingClientRect();
  const nodes=dragLayoutBase?dragLayoutBase.map(n=>({id:n.id,rect:{left:canvas.left+n.left,top:canvas.top+n.top,right:canvas.left+n.left+n.width,bottom:canvas.top+n.top+n.height}})):$$('#flowNodes .flow-node').map(el=>({id:el.dataset.node,rect:el.getBoundingClientRect()}));
  return {zone,insertion:zone==='editor'?insertionAt(point,footprint,nodes,{layout:'vertical',sourceId,previous}):null};
}
function clearDropTarget(releaseLayout=null){
  if(!dragPreview&&!releaseLayout)return;
  const before=releaseLayout||captureFlowLayout();
  stopFlowMotion();
  $('#flowScroll').classList.remove('drop-ready');
  $('.snap-preview')?.remove();
  const hadPreview=!!dragPreview;
  dragPreview?.slot.remove();dragPreview=null;
  $('#flowCanvas').classList.remove('has-snap-preview');
  $$('#flowNodes .drop-target').forEach(el=>{el.classList.remove('drop-target');delete el.dataset.dropSide;delete el.dataset.dropAxis;delete el.dataset.dropDirection;});
  if(hadPreview||releaseLayout){drawEdges();animateFlowLayout(before);}
}
function showDropTarget(target,sourceId=null,footprint=null){
  const insertion=target.insertion;
  if(!insertion||!footprint){clearDropTarget();return null;}
  $('#flowScroll').classList.add('drop-ready');
  $$('#flowNodes .drop-target').forEach(el=>{el.classList.remove('drop-target');delete el.dataset.dropSide;delete el.dataset.dropAxis;delete el.dataset.dropDirection;});
  const nodes=$$('#flowNodes .flow-node'),el=nodes.find(node=>node.dataset.node===insertion.targetId);if(!el){clearDropTarget();return null;}
  el.classList.add('drop-target');el.dataset.dropSide=insertion.side;el.dataset.dropAxis=insertion.axis;el.dataset.dropDirection=String(insertion.direction);
  const from=nodes.findIndex(node=>node.dataset.node===sourceId);
  const index=from<0?insertion.index:movedInsertionIndex(from,insertion.index,nodes.length);
  if(!dragPreview||dragPreview.index!==index||dragPreview.sourceId!==sourceId){
    const before=captureFlowLayout();stopFlowMotion();
    const slot=dragPreview?.slot||document.createElement('div');slot.className='snap-space';slot.setAttribute('aria-hidden','true');
    const order=nodes.filter(node=>node.dataset.node!==sourceId);order.splice(index,0,slot);
    if(!slot.isConnected)$('#flowNodes').append(slot);
    dragPreview={index,sourceId,slot,order};
    $('#flowCanvas').classList.add('has-snap-preview');drawEdges();animateFlowLayout(before);
  }
  const r=dragPreview.slot.getBoundingClientRect(),vertical=insertion.axis==='y',before=insertion.side==='before',low=before===(insertion.direction===1);
  let marker=$('.snap-preview');if(!marker){marker=document.createElement('div');marker.className='snap-preview';marker.setAttribute('aria-hidden','true');document.body.append(marker);}
  Object.assign(marker.dataset,{snapSide:insertion.side,snapAxis:insertion.axis,snapDirection:String(insertion.direction)});
  // A two-pixel glow marks just the receiving seam; no popup covers the cards.
  Object.assign(marker.style,vertical?{left:`${r.left+r.width*.2}px`,top:`${before?r.bottom+3:r.top-5}px`,width:`${r.width*.6}px`,height:'2px'}:{left:`${low?r.right+3:r.left-5}px`,top:`${r.top+r.height*.2}px`,width:'2px',height:`${r.height*.6}px`});
  return {left:r.left+r.width*(1-DRAG_SCALE)/2,top:r.top+r.height*(1-DRAG_SCALE)/2,width:r.width,height:r.height,scale:DRAG_SCALE,side:insertion.side};
}
function animateSnapPlacement(id){
  if(!id)return;
  requestAnimationFrame(()=>{drawEdges();const el=$$('#flowNodes .flow-node').find(node=>node.dataset.node===id);if(!el)return;el.classList.add('snap-landed');el.addEventListener('animationend',()=>el.classList.remove('snap-landed'),{once:true});setTimeout(()=>el.classList.remove('snap-landed'),300);});
}
function scrollDraggedFlow(footprint,zone){
  const flow=$('#flowScroll');if(zone!=='editor'||flow.classList.contains('flow-fitted'))return;
  const r=flow.getBoundingClientRect(),y=(footprint.top+footprint.bottom)/2;if(y<r.top+30)flow.scrollTop-=12;else if(y>r.bottom-30)flow.scrollTop+=12;
}
$('#flowNodes').addEventListener('pointerdown',e=>{
  if(!editable()||e.button>0||e.target.closest('input,select,[data-port]')||state.connecting)return;
  const card=e.target.closest('.flow-node:not(.terminal)');if(!card)return;
  const id=card.dataset.node;let previous=null;
  beginCardDrag(e,{
    getSource:()=>$$('#flowNodes .flow-node').find(n=>n.dataset.node===id),
    onStart:()=>$('.control-panel').classList.add('delete-ready'),
    onMove:(point,footprint)=>{
      const target=cardDropTarget(point,footprint,id,previous);previous=target.insertion;
      $('.control-panel').classList.toggle('delete-hover',target.zone==='palette');
      const snap=showDropTarget(target,id,footprint);scrollDraggedFlow(footprint,target.zone);return snap;
    },
    onDrop:(point,footprint)=>{
      const target=cardDropTarget(point,footprint,id,previous);
      if(target.zone==='palette'&&beforeEdit()){state.graph.nodes=state.graph.nodes.filter(n=>n.id!==id);state.selected=null;chain();changed();toast(isDelivery()?'积木已移除，可撤销恢复':'操作卡已移除，可撤销恢复');}
      else if(target.insertion){const from=state.graph.nodes.findIndex(n=>n.id===id),to=movedInsertionIndex(from,target.insertion.index,state.graph.nodes.length);if(from>0&&to!==from&&beforeEdit()){const [node]=state.graph.nodes.splice(from,1);state.graph.nodes.splice(to,0,node);chain();state.selected=id;changed();animateSnapPlacement(id);}}
    },
    onTap:()=>selectNode(id),
    onCleanup:releaseLayout=>{$('.control-panel').classList.remove('delete-ready','delete-hover');clearDropTarget(releaseLayout);}
  });
});
$('#inspector').addEventListener('change',e=>{const n=state.graph.nodes.find(n=>n.id===state.selected);if(!n||!beforeEdit())return;if(e.target.hasAttribute('data-destination')){const p=DELIVERY_MAP.points[e.target.value];if(p)n.params={x:p.x,y:p.y};}else if(e.target.id==='nodeLabel'){const value=e.target.value.trim();if(value)n.label=value;else delete n.label;}else if(e.target.dataset.param){n.params[e.target.dataset.param]=e.target.value;}changed();});
$('#inspector').addEventListener('click',e=>{const type=e.target.dataset.edit;if(!type)return;if(type==='done'){state.selected=null;renderGraph();return;}if(type==='up'||type==='down')moveNode(state.selected,type==='up'?-1:1);if(type==='delete'&&beforeEdit()){state.graph.nodes=state.graph.nodes.filter(n=>n.id!==state.selected);state.selected=null;chain();changed();}});
$('#actionCards').addEventListener('click',e=>{if(Date.now()>=dragClickUntil&&e.target.closest('[data-action]'))toast('把操作卡拖到中间画布，就能添加。');});
$('#chapters').addEventListener('click',e=>{const b=e.target.closest('[data-chapter]');if(b&&!state.session&&!state.running)changeChapter(Number(b.dataset.chapter));});
$('#practiceTasks').addEventListener('click',e=>{const button=e.target.closest('[data-practice-task]');if(button)selectPracticeTask(button.dataset.practiceTask);});
$('#chainButton').onclick=()=>{if(beforeEdit()){chain();changed();toast('已按步骤编号连接');}};
$('#connectButton').onclick=()=>{state.connecting=!state.connecting;state.connectFrom=null;updateControls();toast(state.connecting?'依次点两个框，画出执行箭头':'已退出手动连线');};
$('#undoButton').onclick=()=>{if(editable()&&state.undo.length){state.graph=state.undo.pop();state.selected=null;changed();}};
$('#clearButton').onclick=()=>{if(beforeEdit()){state.graph=cleanGraph();chain();state.selected=null;changed();}};
window.addEventListener('resize',requestGraphLayout);
new ResizeObserver(requestGraphLayout).observe($('#flowScroll'));

$('#flowNodes').addEventListener('change',e=>{
  const axis=e.target.dataset.nodeCoordinate,n=state.graph.nodes.find(n=>n.id===e.target.closest('[data-node]')?.dataset.node);
  if(!axis||!n||!beforeEdit())return;n.params[axis]=e.target.value===''?'':Number(e.target.value);changed();
});
$('#coordinateCards').addEventListener('click',e=>{if(Date.now()>=dragClickUntil&&e.target.closest('[data-coordinate]'))toast('把坐标卡拖到中间画布，拼接配送积木。');});
$('.control-panel').addEventListener('pointerdown',e=>{
  const source=e.target.closest('[data-palette-drag]');if(!source||!editable()||e.button>0)return;
  const action=source.dataset.paletteDrag,coordinate=source.dataset.coordinate,params=source.dataset.x!==undefined?{x:Number(source.dataset.x),y:Number(source.dataset.y)}:null;let previous=null;
  beginCardDrag(e,{
    getSource:()=>coordinate?$$('#coordinateCards [data-coordinate]').find(el=>el.dataset.coordinate===coordinate):$$('#actionCards [data-palette-drag]').find(el=>el.dataset.paletteDrag===action),
    getCanvasGhost:()=>paletteCanvasGhost(action,params),
    onMove:(point,footprint)=>{const target=cardDropTarget(point,footprint,null,previous);previous=target.insertion;const snap=showDropTarget(target,null,footprint);scrollDraggedFlow(footprint,target.zone);return snap;},
    onDrop:(point,footprint)=>{
      const target=cardDropTarget(point,footprint,null,previous);if(target.zone!=='editor')return;
      animateSnapPlacement(addAction(action,params,target.insertion?.index??null));
    },
    onTap:()=>toast('把蓝色卡片拖到中间画布，就能添加。'),
    onCleanup:clearDropTarget
  });
});
for(const area of [$('#flowNodes'),$('.control-panel')])area.addEventListener('dragstart',e=>{if(e.target.closest('.flow-node,[data-palette-drag]'))e.preventDefault();});
const world=new SupermarketWorld($('#world'),{onExplore:point=>{if(isDelivery())$('#dialogueText').textContent=`探路位置（${point.x},${point.y}）。上方的第二个数更大，转弯时把道路坐标填入积木。`;},onInteract:id=>{if(state.chapter===3&&TASKS.some(t=>t.chapterId===3&&t.id===id)){selectPracticeTask(id);return;}$('#dialogueText').textContent=isDelivery()?'先看冷藏订单的时限，再安排顺路配送。每块积木直走，转弯时再加坐标。':task().description;},onTarget:id=>{if(isDelivery()&&DELIVERY_MAP.points[id])addAction('move_to',{...DELIVERY_MAP.points[id]});else toast(`已选中${id}，请在步骤框内设置对应操作`);}});

function renderPracticeTasks(){
  const panel=$('#practiceTasks');panel.hidden=state.chapter!==3;
  panel.innerHTML=TASKS.filter(t=>t.chapterId===3).map(t=>`<button type="button" data-practice-task="${t.id}" aria-pressed="${t.id===state.taskId}" ${editable()?'':'disabled'}>${esc({'rice-roll':'饭卷',tea:'茶饮',plant:'绿植',fish:'观赏鱼'}[t.id])}</button>`).join('');
}
async function selectPracticeTask(taskId){
  if(state.chapter!==3||!editable()||!TASKS.some(t=>t.chapterId===3&&t.id===taskId))return false;
  if(taskId===state.taskId){$('#dialogueText').textContent=task().description;return true;}
  state.switchingTask=true;updateControls();
  try{
    if(state.session){
      // Save the old task before the server announces the new selection. Drafts
      // use independent task keys, so pending uploads remain safe after switching.
      await persistNow();
      const result=await api('/api/student/task',{method:'POST',body:{taskId}});
      await acceptRoom(result);
    }else await changeChapter(3,taskId,{transition:false});
    toast(`已切换到${{'rice-roll':'饭卷',tea:'茶饮',plant:'绿植',fish:'观赏鱼'}[state.taskId]}任务，各区流程图分别保存`);
    return state.taskId===taskId;
  }catch(error){
    if(error.data?.identityMismatch){state.authExpired=true;syncCurrentClass();}
    else if(error.status===409)alignRoom().catch(()=>{});
    toast(error.message||'暂时无法切换，请连接课堂后再试');return false;
  }finally{state.switchingTask=false;renderPracticeTasks();renderNotice();updateControls();}
}

async function changeChapter(ch,taskId=defaultTask(ch),{fromTeacher=false,transition=true}={}){
  cancelCardDrag?.();
  if($('#submitDialog').open)$('#submitDialog').close();
  if(!TASKS.some(t=>t.chapterId===ch&&t.id===taskId))taskId=defaultTask(ch);
  if(state.running||state.demo)await stopRun('interrupted','老师切换了章节');
  if(state.graph){clearTimeout(saveTimer);await persistNow({kind:fromTeacher?'archive':'draft'});}
  state.chapter=ch;state.taskId=taskId;state.selected=null;state.undo=[];state.connecting=false;state.connectFrom=null;state.activeNode=null;state.errorNode=null;
  const saved=await db.get(graphKey()).catch(()=>null);state.graph=currentDeliveryDraft(saved?.graph||cleanGraph());if(!saved)chain();
  else if(state.graph!==saved.graph)await safeSet(graphKey(),{...saved,graph:state.graph,updatedAt:Date.now()});
  state.submittedFingerprint=await db.get(`submitted:${graphKey()}`);
  world.setChapter(ch,taskId);world.setState(initialState(ch,taskId));resetMetrics();$('#result').hidden=true;$('#comparison').hidden=true;$('#inspector').hidden=true;
  renderChapter();
  if(transition){const el=$('#transition');el.querySelector('strong').textContent=CHAPTERS[ch-1].title;el.querySelector('p').textContent=CHAPTERS[ch-1].subtitle;el.hidden=false;clearTimeout(transitionTimer);transitionTimer=setTimeout(()=>el.hidden=true,1100);}
  await safeSet(`last:${scope()}`,{chapter:ch,taskId});
}
function resetMetrics(){paintMetrics({walk:0,handling:0,total:0},initialState(state.chapter,state.taskId));}
function paintMetrics(metrics,current){
  $('#timeValue').textContent=Math.round(metrics.total||0);const orders=current?.orders||[],delivered=orders.filter(o=>o.status==='delivered').length,failed=orders.filter(o=>o.status==='spoiled').length;
  $('#coinsValue').textContent=current?.coins??metrics.coins??0;$('#deliveredValue').textContent=`${delivered} / 6`;$('#failedValue').textContent=failed;
  $('#metrics').classList.toggle('overtime',failed>0);if(!isDelivery())return;
  $('#deliveryOrders').innerHTML=orders.map(o=>{const p=DELIVERY_MAP.points[o.point],remaining=Math.max(0,o.deadline-(metrics.total||0)),status=o.status==='delivered'?`送达 +${o.baseReward+Math.floor((o.deadline-o.arrivedAt)/DELIVERY_MAP.bonusEveryMinutes)}币`:o.status==='spoiled'?`变质 -${o.penalty}币`:remaining===0?'已超时 · 待处理':`剩 ${remaining} 分钟`;
    return `<div class="order-card ${o.status} ${o.cold?'cold':''}"><b>${esc(o.point)}${o.cold?' ❄':''}</b><span>${esc(o.name)}<small>（${p.x},${p.y}） · ${o.deadline}分钟内送达</small></span><strong>${status}</strong></div>`;}).join('');
}
const routesFor=run=>({points:(normalizeDeliveryResult(run.result||{trace:run.trace||[]},run.graph)?.trace||[]).flatMap(step=>step.events.filter(e=>e.type==='walk').flatMap(e=>e.path||[]))});
function validRuns(){return state.runs.filter(r=>r.chapterId===state.chapter&&r.taskId===state.taskId&&r.valid&&(!isDelivery()||deliveryRulesVersion(r)===deliveryRulesVersion(state.graph))).sort((a,b)=>a.createdAt-b.createdAt);}
function renderComparison(){
  const list=validRuns(),el=$('#comparison');el.hidden=!isDelivery()||!list.length;if(el.hidden)return;
  const first=list[0],latest=list.at(-1),best=list.reduce((a,b)=>(a.metrics.coins??0)>(b.metrics.coins??0)||(a.metrics.coins===b.metrics.coins&&a.metrics.total<=b.metrics.total)?a:b);
  el.innerHTML=`<div class="compare-title">同样的六份订单 <button class="quiet" id="routesButton">比较路线</button></div><div class="compare-cards">${[['首次',first],['本次',latest],['最好',best]].map(([name,r])=>`<div class="compare-card ${name==='最好'?'best':''}">${name}<strong>${r.metrics.coins} <small>金币</small></strong><small>${r.metrics.total}分钟 · 失败${r.metrics.failed}单</small></div>`).join('')}</div><p>${list.length>1?`本次比首次${latest.metrics.total<=first.metrics.total?'少用':'多用'} ${Math.abs(first.metrics.total-latest.metrics.total)} 分钟，金币${latest.metrics.coins-first.metrics.coins>=0?'增加':'减少'} ${Math.abs(latest.metrics.coins-first.metrics.coins)}。`:'优先照顾冷藏订单，再试着减少绕路。'}</p>`;
  $('#routesButton').onclick=()=>{world.setRoutes([{...routesFor(first),color:'#d89b4c',dashed:true,label:'首次'},{...routesFor(latest),color:'#3d8d80',label:'本次'}]);toast('虚线：首次路线；实线：本次路线。');};
}
async function waitToContinue(epoch){while((state.userPaused||state.teacherPaused)&&state.runEpoch===epoch)await new Promise(r=>setTimeout(r,70));return state.runEpoch===epoch;}
async function animateResult(result,{demo=false,graph=snapshot(),record=null}={}){
  const epoch=++state.runEpoch;state.demo=demo;state.userPaused=false;state.teacherPaused=!!state.session&&state.session.phase==='paused';state.activeNode=null;state.errorNode=null;
  const metrics={walk:0,handling:0,total:0};let current=copy(result.initialState);
  world.stop();world.reset();world.setState(current);world.setRoutes([]);paintMetrics(metrics,current);updateControls();
  for(const step of result.trace){
    if(!await waitToContinue(epoch))return false;state.activeNode=step.nodeId;renderGraph();
    revealNode(step.nodeId);
    $('#dialogueText').textContent=step.actionId==='start'?'从初始状态开始。':step.actionId==='end'?(isDelivery()?'已经执行到程序末尾。':'按照箭头，走到了结束框。'):`${demo?'师傅示范':'正在执行'}：${step.label||actionLabel(step)}`;
    for(const event of step.events){
      if(!await waitToContinue(epoch))return false;
      const path=event.path||[];
      if(event.type==='walk'&&path.length>1){
        for(let i=1;i<path.length;i++){
          if(!await waitToContinue(epoch))return false;
          const last=i===path.length-1,part={...event,path:[path[i-1],path[i]],from:path[i-1],to:path[i],duration:event.duration/(path.length-1)};delete part.state;
          if(last&&event.state)part.state=event.state;
          await world.playEvent(part,{speed:5});if(epoch!==state.runEpoch)return false;
          current={...current,position:copy(path[i])};if(last&&event.state)current=copy(event.state);
          metrics.walk+=event.duration/(path.length-1);metrics.total=metrics.walk+metrics.handling;
          if(isDelivery()){current.elapsed=metrics.total;world.setState(current);}paintMetrics(metrics,current);
        }
      }else{
        await world.playEvent(event,{speed:3});if(epoch!==state.runEpoch)return false;
        if(event.state)current=copy(event.state);metrics.handling+=event.duration;metrics.total=metrics.walk+metrics.handling;paintMetrics(metrics,current);
      }
    }
    world.setState(step.after);current=copy(step.after);if(record){record.executedNodes.push(step.nodeId);await safeSet(`run:${scope()}:${record.id}`,copy(record));}
  }
  if(epoch!==state.runEpoch)return false;
  state.activeNode=null;state.errorNode=result.errorNodeId||null;state.demo=false;
  if(!demo)paintMetrics(result.metrics,result.finalState);world.setState(result.finalState);renderGraph();
  if(demo){$('#dialogueText').textContent='示范结束了。请在中间画布安排步骤，再运行一次。';world.reset();resetMetrics();toast('示范不会写入你的作品或成绩');}
  else showResult(result);
  updateControls();return true;
}
function showResult(result){
  const el=$('#result'),delivery=isDelivery(),failed=result.metrics.failed||0;el.hidden=false;el.className=`result ${!result.completed||failed?'error':''}`;
  el.innerHTML=result.completed?`<strong>${delivery?(failed?`配送结束，${failed}单超时`:'六单全部成功送达！'):'任务完成！'}</strong>${esc(delivery?`行走 ${result.metrics.walk} 分钟 + 交付 ${result.metrics.handling} 分钟 = ${result.metrics.total} 任务分钟，获得 ${result.metrics.coins} 金币。`:CHAPTERS[state.chapter-1].outro)}<br><button class="secondary" id="tryAgain">${delivery?'调整积木，再送一次':'调整流程，再试一次'}</button>`:`<strong>${delivery?'配送员在这里停住了':'小店员在这里停住了'}</strong>${esc(result.message||result.errors?.[0]?.message||'请检查步骤。')}<br><span>${delivery?'检查目标坐标；转弯处需要再加一块积木。':'修改标出的步骤或连线，再从开始运行。'}</span>`;
  if($('#tryAgain'))$('#tryAgain').onclick=()=>{world.reset();resetMetrics();el.hidden=true;};$('#dialogueText').textContent=result.completed?(failed?'有订单超时变质了。改一改顺序，先送需要冷藏的商品。':CHAPTERS[state.chapter-1].outro):result.message;
  if(stackedLayout())requestAnimationFrame(()=>el.scrollIntoView({block:'nearest'}));
}
async function startRun(){
  if(!editable())return;
  state.graph=currentDeliveryDraft(state.graph);
  const graph=snapshot(),result=simulate(graph,{chapterId:state.chapter,taskId:state.taskId});
  const record={id:uid(),runId:null,chapterId:state.chapter,taskId:state.taskId,graph,executedNodes:[],status:'running',createdAt:Date.now(),result:null,valid:false};record.runId=record.id;
  state.running=record;$('#result').hidden=true;
  await safeSet(`run:${scope()}:${record.id}`,copy(record));
  try{const finished=await animateResult(result,{graph,record});if(!finished)return;
    record.status=result.completed?'completed':'failed';record.valid=!!result.completed;record.result=copy(result);record.metrics=record.valid?copy(result.metrics):null;
    state.running=null;await storeRun(record);renderComparison();updateControls();
  }catch(e){console.error(e);await stopRun('stopped','播放未完成');toast('动画未完成，已保存本次记录。请重新运行。');}
}
async function storeRun(record){
  await safeSet(`run:${scope()}:${record.id}`,record);state.runs=state.runs.filter(r=>r.id!==record.id);state.runs.push(record);
  clearTimeout(saveTimer);const key=graphKey(record.chapterId,record.taskId);await safeSet(key,{graph:record.graph,updatedAt:Date.now()});
  await enqueue({kind:'run',key,graph:record.graph,run:record});
}
async function stopRun(status='stopped',reason='学生主动停止'){
  if(!state.running&&!state.demo)return;state.runEpoch++;world.stop();const record=state.running;state.running=null;state.demo=false;state.activeNode=null;state.userPaused=false;
  if(record){record.status=status;record.valid=false;record.reason=reason;record.result={completed:false,trace:simulate(record.graph).trace.slice(0,record.executedNodes.length),message:reason};record.metrics=null;await storeRun(record);}
  world.reset();resetMetrics();renderGraph();updateControls();if(status==='stopped')toast('已停止，本次执行记录已保留');
}
$('#runButton').onclick=startRun;
$('#pauseButton').onclick=()=>{if(state.teacherPaused)return;state.userPaused=!state.userPaused;if(state.userPaused)world.pause();else world.resume();updateControls();};
$('#stopButton').onclick=()=>stopRun();
$('#demoButton').onclick=async()=>{
  if(state.running||state.demo)return;
  const graph=exampleGraph(state.chapter,state.taskId,isDelivery()?'demo':'best');await animateResult(simulate(graph),{demo:true,graph});updateControls();
};

// Each queue item is a transaction: immutable graph version -> run -> submission.
// A dropped connection can repeat any step without creating duplicate records.
const fingerprint=g=>{const c=copy(g);delete c.revision;return JSON.stringify(c);};
async function enqueue(bundle){
  if(!state.learner)return;
  if(!state.session.openedChapters?.includes(bundle.graph.chapterId)&&!(state.session.chapterId===bundle.graph.chapterId&&state.session.phase==='practice'))return;
  const item={...bundle,id:uid(),mutationId:uid(),offline:!state.online,createdAt:Date.now()};
  if(item.kind==='archive')item.submission={submissionId:uid(),source:'chapter',explanation:''};
  // Coalesce only the last unsent draft; never replace a run's snapshot.
  const previous=state.queue.at(-1);
  if(item.kind==='draft'&&previous?.kind==='draft'&&previous.key===item.key&&!previous.started)state.queue[state.queue.length-1]=item;else state.queue.push(item);
  await safeSet(`queue:${scope()}`,state.queue);$('#saveStatus').textContent='已存此设备 · 正在同步';flushQueue();
}
async function flushQueue(){
  if(state.syncing||state.conflict||!state.learner||!state.online||state.tabBlocked)return;
  state.syncing=true;const learnerId=state.learner.id;
  try{
    while(state.queue.length&&state.learner?.id===learnerId&&state.online&&!state.conflict){
      const item=state.queue[0];item.started=true;
      if(!TASKS.some(task=>task.chapterId===item.graph?.chapterId&&task.id===item.graph?.taskId)){
        const preserved=await safeSet(`backup:${learnerId}:legacy-${item.id}`,{graph:item.graph,transaction:copy(item),reason:'旧版任务的待同步作品，已保留完整副本'});
        if(!preserved)break;
        state.queue.shift();await safeSet(`queue:${learnerId}`,state.queue);continue;
      }
      let meta=await db.get(metaKey(item.key))||{revision:0};
      const offline=item.offline||item.graph.chapterId!==state.session.chapterId||state.session.phase!=='practice';
      if(!item.saved){
        if(meta.fingerprint===fingerprint(item.graph))item.saved={draftId:meta.draftId,revision:meta.revision};
        else{
          const draftId=meta.draftId||`${learnerId}-${item.graph.chapterId}-${item.graph.taskId}`;
          try{
            const response=await api(`/api/student/drafts/${encodeURIComponent(draftId)}`,{method:'PUT',body:{graph:item.graph,baseRevision:meta.revision||0,mutationId:item.mutationId,offline}});
            meta={draftId:response.draft.id,revision:response.draft.revision,fingerprint:fingerprint(item.graph)};
            await safeSet(metaKey(item.key),meta);item.saved={draftId:meta.draftId,revision:meta.revision};
          }catch(error){if(error.status===409&&error.data.conflict){state.conflict={item,response:error.data};renderConflict();break;}throw error;}
        }
        await safeSet(`queue:${learnerId}`,state.queue);
      }
      const {draftId,revision}=item.saved;
      if(item.run&&!item.runUploaded){
        const r=item.run;await api('/api/student/runs',{method:'POST',body:{runId:r.id,draftId,revision,graph:{...item.graph,revision},status:r.status,executedNodes:r.executedNodes,offline,reason:r.reason}});
        item.runUploaded=true;r.syncedRevision=revision;r.syncedDraftId=draftId;r.synced=true;await safeSet(`run:${learnerId}:${r.id}`,r);const local=state.runs.find(x=>x.id===r.id);if(local)Object.assign(local,{syncedRevision:revision,syncedDraftId:draftId,synced:true});
        await safeSet(`queue:${learnerId}`,state.queue);
      }
      if(item.submission&&!item.submissionUploaded){
        const sub=item.submission,run=state.runs.find(r=>r.id===sub.runId);
        const body={...sub,draftId,revision,offline};if(!run||run.syncedRevision!==revision)delete body.runId;
        await api('/api/student/submissions',{method:'POST',body});item.submissionUploaded=true;await safeSet(`submission:${learnerId}:${sub.submissionId}`,{...sub,chapterId:item.graph.chapterId,graph:item.graph,synced:true,createdAt:Date.now()});
      }
      if(state.queue[0]?.id===item.id)state.queue.shift();await safeSet(`queue:${learnerId}`,state.queue);
    }
    if(!state.queue.length)$('#saveStatus').textContent=state.submittedFingerprint&&state.submittedFingerprint!==fingerprint(state.graph)?'新草稿已同步 · 需重新提交':'已同步到老师工作台';
  }catch(error){
    if(error.status===401||error.status===403||error.data?.identityMismatch){$('#saveStatus').textContent='连接待恢复 · 本机作品仍保留';state.online=false;state.authExpired=true;state.stream?.close();renderNotice();updateControls();}
    else if(error.status){$('#saveStatus').textContent='本机已保存 · 同步待处理';toast(error.message);}
    else $('#saveStatus').textContent='离线 · 已保存在此设备';
  }finally{state.syncing=false;renderConnection();}
}
function renderConflict(){const el=$('#conflict');el.hidden=!state.conflict;if(!state.conflict)return;el.innerHTML='另一处保存了更新的版本。你的副本已保留，请选择：<br><button id="keepLocal" class="secondary">保留此平板版本</button><button id="useRemote" class="quiet">采用课堂版本</button>';
  $('#keepLocal').onclick=async()=>{const {item,response}=state.conflict;await safeSet(metaKey(item.key),{draftId:response.draft.id,revision:response.draft.revision,fingerprint:fingerprint(response.draft.graph)});item.mutationId=uid();delete item.saved;state.conflict=null;renderConflict();await safeSet(`queue:${scope()}`,state.queue);flushQueue();};
  $('#useRemote').onclick=async()=>{const {item,response}=state.conflict;await safeSet(`backup:${scope()}:${Date.now()}`,{graph:item.graph,reason:'版本冲突的本机副本'});state.queue=state.queue.filter(q=>q.key!==item.key);const graph=response.draft.graph;await safeSet(item.key,{graph,updatedAt:Date.now()});await safeSet(metaKey(item.key),{draftId:response.draft.id,revision:response.draft.revision,fingerprint:fingerprint(graph)});if(graphKey()===item.key){state.graph=currentDeliveryDraft(copy(graph));renderGraph();}state.conflict=null;renderConflict();await safeSet(`queue:${scope()}`,state.queue);flushQueue();toast('已采用课堂版本；本机旧稿保留在实践记录中');};
}
async function hydrateWorks(data){
  for(const draft of data.drafts||[]){const key=graphKey(draft.chapterId,draft.taskId);await safeSet(metaKey(key),{draftId:draft.id,revision:draft.revision,fingerprint:fingerprint(draft.graph)});const local=await db.get(key);if(!state.queue.some(i=>i.key===key)&&(!local||local.updatedAt<=draft.updatedAt))await safeSet(key,{graph:draft.graph,updatedAt:draft.updatedAt});}
  const records=await db.all(`run:${scope()}:`);state.runs=records.map(x=>x.value);
  for(const r of data.runs||[]){const index=state.runs.findIndex(x=>x.id===r.id);const record={...r,synced:true,syncedRevision:r.revision,syncedDraftId:r.draftId};if(index>=0)state.runs[index]=record;else state.runs.push(record);await safeSet(`run:${scope()}:${r.id}`,record);}
  state.feedback=data.feedback||[];await safeSet(`feedback:${scope()}`,state.feedback);
  for(const sub of data.submissions||[])await safeSet(`submission:${scope()}:${sub.id}`,{...sub,synced:true});
}
let roomApply=Promise.resolve();
function acceptRoom(data){roomApply=roomApply.then(()=>applyRoom(data)).catch(e=>{console.error(e);toast('课堂状态同步未完成，请检查连接');});return roomApply;}
async function applyRoom(data){
  if(!data.session||state.session&&(data.session.id!==state.session.id||data.session.version<state.session.version))return;
  // A late heartbeat/SSE snapshot must not undo a more recent task selection.
  const currentTaskVersion=state.learner?.taskVersion||0,incomingTaskVersion=data.learner?.taskVersion??data.assignment?.taskVersion??0;
  if(incomingTaskVersion<currentTaskVersion){
    data={...data,learner:data.learner?{...data.learner,taskId:state.learner.taskId,taskVersion:currentTaskVersion}:state.learner,
      assignment:data.assignment?{...data.assignment,taskVersion:currentTaskVersion,...(data.session.chapterId===3?{taskId:state.learner.taskId,draftId:`${state.learner.id}-3-${state.learner.taskId}`}:{})}:state.assignment};
  }
  const previous=state.session,chapterChanged=data.session.chapterId!==state.chapter,changed=chapterChanged||data.assignment?.taskId&&data.assignment.taskId!==state.taskId;
  state.session=data.session;if(data.learner)state.learner=data.learner;if(data.assignment)state.assignment=data.assignment;
  await safeSet('participant',{session:state.session,learner:state.learner,assignment:state.assignment});
  if(changed)await changeChapter(state.session.chapterId,data.assignment?.taskId||(state.session.chapterId===3?state.learner.taskId:defaultTask(state.session.chapterId)),{fromTeacher:chapterChanged,transition:chapterChanged});
  if(!changed&&state.session.phase==='explain'&&previous?.phase==='practice')await stopRun('interrupted','老师开始讲解');
  if(state.session.phase==='ended'&&previous?.phase!=='ended'){await stopRun('interrupted','课堂已结束');await persistNow({kind:'archive'});}
  state.teacherPaused=state.session.phase==='paused';
  if(state.running||state.demo){if(state.teacherPaused)world.pause();else if(!state.userPaused)world.resume();}
  renderNotice();renderConnection();updateControls();
  api('/api/student/ack',{method:'POST',body:{version:state.session.version,chapterId:state.chapter}}).catch(()=>{});
}
async function alignRoom(){if(!state.session)return;const id=state.session.id,data=await api(`/api/sessions/${id}/state`);if(state.session?.id===id)await acceptRoom(data);}
function connectStream(){
  state.stream?.close();if(!state.session)return;const stream=new EventSource(`/api/sessions/${state.session.id}/stream?role=student`);state.stream=stream;
  stream.addEventListener('state',event=>{const data=JSON.parse(event.data);acceptRoom(data).then(()=>flushQueue());});
  stream.onopen=()=>{state.online=true;renderConnection();alignRoom().then(()=>flushQueue()).catch(()=>{});};
  stream.onerror=()=>{state.online=false;renderConnection();renderNotice();};
  clearInterval(heartbeat);heartbeat=setInterval(async()=>{if(!state.session)return;try{await alignRoom();flushQueue();}catch{}},8000);
}
function startTabLease(){
  clearInterval(leaseTimer);channel?.close();if(!state.learner)return;
  const key=`supermarket-tab:${state.learner.id}`;
  const check=()=>{let locked=false;try{const current=JSON.parse(localStorage.getItem(key)||'null');if(current&&current.id!==identityToken&&Date.now()-current.at<12000)locked=true;else localStorage.setItem(key,JSON.stringify({id:identityToken,at:Date.now()}));}catch{}if(state.tabBlocked!==locked){state.tabBlocked=locked;if(locked&&state.running)stopRun('interrupted','此课堂已在另一标签页操作');renderNotice();updateControls();}};
  check();leaseTimer=setInterval(check,4000);if('BroadcastChannel' in window){channel=new BroadcastChannel(key);channel.onmessage=check;channel.postMessage('joined');}
}
async function enterClass(data){
  const sameIdentity=state.learner?.id===data.learner.id&&state.session?.id===data.session.id;
  clearTimeout(saveTimer);state.authExpired=true;state.classUnavailable=false;state.learner=data.learner;state.session=data.session;state.assignment=data.assignment||null;state.tabBlocked=false;state.conflict=null;renderConflict();
  if(!sameIdentity){
    state.chapter=data.session.chapterId;state.taskId=data.assignment?.taskId||(state.chapter===3?data.learner.taskId:defaultTask(state.chapter));
    state.graph=cleanGraph();chain();state.selected=null;state.undo=[];state.runs=[];state.feedback=[];
    world.setChapter(state.chapter,state.taskId);world.setState(initialState(state.chapter,state.taskId));resetMetrics();renderChapter();
  }
  state.queue=await db.get(`queue:${scope()}`,[]);await safeSet('participant',{session:state.session,learner:state.learner,assignment:state.assignment});
  await hydrateWorks(await api('/api/student/works'));const current=await api(`/api/sessions/${state.session.id}/state`);state.assignment=current.assignment;
  state.graph=null;await changeChapter(current.session.chapterId,current.assignment.taskId,{transition:false});await acceptRoom(current);state.authExpired=false;startTabLease();connectStream();flushQueue();
  for(const dialog of ['#welcome','#identityDialog','#recoverDialog'])if($(dialog).open)$(dialog).close();
}
async function getDeviceToken(){
  let prior;try{prior=localStorage.getItem('supermarket.auto-device');}catch{}
  return db.getOrCreate('autoDeviceToken',/^[-_A-Za-z0-9]{32,256}$/.test(prior||'')?prior:uid()+uid());
}
async function prepareClassSwitch({archive=true,persist=true}={}){
  state.joining=true;renderConnection();renderNotice();updateControls();
  state.stream?.close();clearInterval(heartbeat);await roomApply;
  await stopRun('interrupted','老师切换了当前课堂');
  if(state.graph&&persist)await persistNow({kind:archive?'archive':'draft'});
  await flushQueue();
  while(state.syncing)await new Promise(resolve=>setTimeout(resolve,50));
  clearInterval(leaseTimer);channel?.close();
  if(state.learner)try{const key=`supermarket-tab:${state.learner.id}`,lease=JSON.parse(localStorage.getItem(key)||'null');if(lease?.id===identityToken)localStorage.removeItem(key);}catch{}
}
let classSync=null;
function syncCurrentClass(){
  if(classSync)return classSync;
  if(!navigator.onLine||state.joining||!deviceToken||!state.graph)return Promise.resolve();
  classSync=(async()=>{
    let switching=false;
    try{
      const {session}=await api('/api/student/current');
      if(!session){state.classUnavailable=!!state.learner&&state.session?.phase!=='ended';return;}
      if(session.id===state.session?.id&&!state.authExpired&&linkedSessionId===session.id){state.classUnavailable=false;return;}
      const changed=session.id!==state.session?.id;
      switching=true;await prepareClassSwitch({archive:changed,persist:changed});
      const joined=await api('/api/student/auto-join',{method:'POST',body:{deviceToken}});
      if(!joined.learner){state.classUnavailable=!!state.learner;return;}
      await enterClass(joined);
      linkedSessionId=joined.session.id;
      history.replaceState(null,'','/');
      toast(`已领取工牌 ${learnerCode()}，请按老师的安排开始。`);
    }catch(error){
      if(error.status===401||error.status===403)state.authExpired=true;
      if(switching&&state.session&&!state.authExpired)connectStream();
    }finally{
      state.joining=false;state.checkingClass=false;renderConnection();renderNotice();updateControls();classSync=null;
    }
  })();
  return classSync;
}
$('#practiceButton').onclick=()=>{safeSet('hasEntered',true);$('#welcome').close();};
$('#joinOpenButton').onclick=async e=>{e.preventDefault();safeSet('hasEntered',true);$('#welcome').close();await syncCurrentClass();if(!state.learner)toast('老师开课后会自动加入，先在这里等一等。');};
$('#accountButton').onclick=async()=>{
  if(!state.learner){await syncCurrentClass();if(!state.learner)toast('老师开课后会自动加入，无需填写信息。');return;}
  $('#identityCode').textContent=learnerCode();$('#identityClass').textContent=state.session?.name||'超市实践课堂';$('#identityDialog').showModal();
};
$('#recoverButton').onclick=()=>{$('#identityDialog').close();$('#recoverError').textContent='';$('#recoverDialog').showModal();$('#recoveryCode').focus();};
$('#recoverForm').onsubmit=async e=>{
  e.preventDefault();if(classSync)await classSync;const button=e.target.querySelector('[type=submit]');button.disabled=true;$('#recoverError').textContent='';
  try{await prepareClassSwitch();const data=await api('/api/student/recover',{method:'POST',body:{recoveryCode:$('#recoveryCode').value.trim(),deviceToken}});await enterClass(data);linkedSessionId=data.session.id;toast(`已找回 ${learnerCode()} 的作品。`);}
  catch(error){$('#recoverError').textContent=error.message;if(state.session&&!state.authExpired)connectStream();}
  finally{button.disabled=false;state.joining=false;renderConnection();renderNotice();updateControls();}
};
$$('.dialog-close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#submitButton').onclick=()=>{if(!editable())return;$('#submitPrompt').textContent=state.chapter===4?'你为什么这样安排配送顺序和拐点？怎样保护冷藏商品，又能多得金币？':'你先做什么，再做什么？哪些步骤的先后很重要？';const same=state.runs.filter(r=>r.chapterId===state.chapter&&fingerprint(r.graph)===fingerprint(state.graph)).at(-1);$('#submitHint').textContent=same?.valid?(isDelivery()?(same.metrics?.failed?'这轮程序已执行完，有订单超时；也可以提交改进想法。':'这轮配送程序已成功送达六单。'):'这份流程图已成功完成任务。'):(isDelivery()?'这份配送程序还没有完整运行记录，也可以先提交想法。':'这份流程图还没有成功完成的运行记录，也可以先提交你的想法。');$('#submitDialog').showModal();};
$('#submitForm').onsubmit=async e=>{e.preventDefault();if(!editable()){$('#submitDialog').close();return toast('老师尚未开放操作，请等待。');}const graph=snapshot(),run=state.runs.filter(r=>r.chapterId===state.chapter&&fingerprint(r.graph)===fingerprint(graph)).at(-1),submission={submissionId:uid(),explanation:$('#explanation').value.trim(),source:'student',...(run?{runId:run.id}:{})};await safeSet(`submission:${scope()}:${submission.submissionId}`,{...submission,graph,chapterId:state.chapter,createdAt:Date.now()});state.submittedFingerprint=fingerprint(graph);await safeSet(`submitted:${graphKey()}`,state.submittedFingerprint);await persistNow({kind:'submission',submission});$('#submitDialog').close();$('#explanation').value='';toast(state.learner?'作品已保存，将同步给老师':'作品已保存在此设备');$('#saveStatus').textContent=state.learner?'已提交 · 同步中':'作品已提交到本机记录';};
$('#historyButton').onclick=async()=>{if(state.learner&&state.online)try{await hydrateWorks(await api('/api/student/works'));}catch{}await showHistory();$('#historyDialog').showModal();};
$('#historyTopButton').onclick=()=>$('#historyButton').click();
async function showHistory(){
  const runs=state.runs.slice().sort((a,b)=>b.createdAt-a.createdAt);const backups=await db.all(`backup:${scope()}:`);let content=runs.length?runs.map((r,i)=>`<article class="history-item"><strong>第${r.chapterId}站 · ${esc(TASKS.find(t=>t.id===r.taskId)?.name||r.taskId)} · ${r.valid?(r.metrics?.failed?'完成 · 有订单失败':'完成'):r.status==='failed'?'需修改':r.status==='interrupted'?'切章中断':'已停止'}</strong><p>${new Date(r.createdAt).toLocaleTimeString('zh-CN')} ${r.valid&&r.chapterId===4?` · 用时${r.metrics.total}分钟，金币${r.metrics.coins??0}，失败${r.metrics.failed??0}单`:''}${state.learner?(r.synced?' · 已同步':' · 本机记录'):''}</p><button class="secondary" data-history="${r.id}">查看当时的作品</button>${!state.session||state.chapter===r.chapterId&&allowed()?`<button class="quiet" data-restore="${r.id}">恢复为当前草稿</button>`:''}</article>`).join(''):'<p>还没有运行记录。画好流程图后，试着运行一次。</p>';
  const drafts=await db.all(`draft:${scope()}:`),submissions=await db.all(`submission:${scope()}:`);
  content='<button class="secondary" id="exportLocal">下载我的作品备份</button><h3>运行记录</h3>'+content;
  content+='<h3>各站草稿</h3>'+drafts.map(({key,value})=>`<article class="history-item"><strong>第${value.graph.chapterId}站 · ${esc(TASKS.find(t=>t.id===value.graph.taskId)?.name||value.graph.taskId)}</strong><button class="quiet" data-draft="${esc(key)}">查看当前草稿</button></article>`).join('');
  if(submissions.length)content+='<h3>提交与想法</h3>'+submissions.sort((a,b)=>b.value.createdAt-a.value.createdAt).map(({value:s})=>`<article class="history-item"><strong>第${s.chapterId}站 · ${s.source==='chapter'?'切章保留':'主动提交'}</strong><p>${esc(s.explanation||'未填写文字说明')}${s.synced?' · 已同步':''}</p></article>`).join('');
  content+=backups.map(({key,value})=>`<article class="history-item"><strong>保留的本机副本</strong><button class="secondary" data-backup="${esc(key)}">查看流程图</button></article>`).join('');
  content+=state.feedback.map(f=>`<div class="feedback">老师对第${f.chapterId}站的反馈：${esc(f.text)}</div>`).join('');$('#historyList').innerHTML=content;
  $('#exportLocal').onclick=async()=>{const records=(await db.all()).filter(({key})=>key.includes(`:${scope()}:`)||key===`feedback:${scope()}`);const blob=new Blob([JSON.stringify({app:'ordered-supermarket',exportedAt:new Date().toISOString(),learner:state.learner,records},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='我的超市实践作品.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);};
}
function viewGraph(graph,title){graph=normalizeDeliveryGraph(graph);const ordered=validateGraph(graph).order;const nodes=ordered.length?ordered.map(id=>graph.nodes.find(n=>n.id===id)):graph.nodes;$('#historyList').innerHTML=`<button class="quiet" id="historyBack">← 返回记录</button><h3>${esc(title)}</h3><div class="history-flow">${nodes.map(n=>`<div class="history-item"><strong>${esc(n.label||actionLabel(n.kind==='action'?n:{actionId:n.kind}))}</strong>${n.label?`<p>实际操作：${esc(actionLabel(n))}</p>`:''}</div>`).join(graph.taskId==='delivery'?'':'<div style="text-align:center">↓</div>')}</div>`;$('#historyBack').onclick=showHistory;}
$('#historyList').onclick=async e=>{
  if(e.target.dataset.history){const r=state.runs.find(r=>r.id===e.target.dataset.history);viewGraph(r.graph,`第${r.chapterId}站 · 当时的作品`);}
  if(e.target.dataset.backup){const value=await db.get(e.target.dataset.backup);viewGraph(value.graph,'保留的本机副本');}
  if(e.target.dataset.draft){const value=await db.get(e.target.dataset.draft);viewGraph(value.graph,'当前保存的草稿');}
  if(e.target.dataset.restore){const r=state.runs.find(r=>r.id===e.target.dataset.restore);if(!r||state.running)return;if(!TASKS.some(t=>t.chapterId===r.chapterId&&t.id===r.taskId))return toast('旧版任务作品保留在记录中，可查看和下载。');if(state.session&&(r.chapterId!==state.chapter||!allowed()))return toast('只能恢复老师当前开放章节的草稿');if(state.session&&r.chapterId===3&&r.taskId!==state.taskId){if(!await selectPracticeTask(r.taskId))return;}else if(r.chapterId!==state.chapter||r.taskId!==state.taskId)await changeChapter(r.chapterId,r.taskId);if(beforeEdit()){state.graph=currentDeliveryDraft(copy(r.graph));state.selected=null;changed();$('#historyDialog').close();toast('已恢复为新草稿，请重新运行并提交');}}
};
window.addEventListener('online',async()=>{state.online=true;renderConnection();try{await syncCurrentClass();await alignRoom();flushQueue();}catch{}});
window.addEventListener('offline',()=>{state.online=false;renderConnection();renderNotice();$('#saveStatus').textContent='离线 · 已保存在此设备';});
window.addEventListener('beforeunload',()=>{try{const key=`supermarket-tab:${state.learner?.id}`,lease=JSON.parse(localStorage.getItem(key)||'null');if(lease?.id===identityToken)localStorage.removeItem(key);}catch{}if(state.graph)safeSet(graphKey(),{graph:snapshot(),updatedAt:Date.now()});});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&state.graph){persistNow();if(state.running)safeSet(`run:${scope()}:${state.running.id}`,state.running);}else syncCurrentClass().then(()=>alignRoom()).then(flushQueue).catch(()=>{});});
async function bootstrap(){
  deviceToken=await getDeviceToken();
  let participant=await db.get('participant').catch(()=>null),me=null;try{me=await api('/api/me');}catch{}
  if(me?.role==='student')participant=me;
  else if(me&&participant?.learner){state.authExpired=true;state.online=false;}
  if(participant?.learner&&participant.session){
    state.learner=participant.learner;state.session=participant.session;state.assignment=participant.assignment;state.queue=await db.get(`queue:${scope()}`,[]);
    if(state.online)try{await hydrateWorks(await api('/api/student/works'));}catch{}else{state.runs=(await db.all(`run:${scope()}:`)).map(x=>x.value);state.feedback=await db.get(`feedback:${scope()}`,[]);}
    let room;try{room=await api(`/api/sessions/${state.session.id}/state`);}catch{}
    const ch=room?.session.chapterId||state.session.chapterId,t=room?.assignment.taskId||state.assignment?.taskId||(ch===3?state.learner.taskId:defaultTask(ch));
    await changeChapter(ch,t,{transition:false});if(room)await acceptRoom(room);if(!state.authExpired){startTabLease();connectStream();}
  }else{
    state.runs=(await db.all('run:practice:')).map(x=>x.value);const last=await db.get('last:practice');await changeChapter(last?.chapter||1,last?.taskId||'drink-swap',{transition:false});
  }
  // A page closed in mid-run keeps an interrupted record, never a completion.
  for(const r of state.runs.filter(r=>r.status==='running')){r.status='interrupted';r.valid=false;r.reason='页面关闭前尚未执行完毕';r.result={trace:simulate(r.graph).trace.slice(0,r.executedNodes.length),message:r.reason};await storeRun(r);}
  await syncCurrentClass();state.checkingClass=false;
  if(!state.learner&&!await db.get('hasEntered'))$('#welcome').showModal();
  clearInterval(classTimer);classTimer=setInterval(()=>syncCurrentClass(),4000);
  renderConnection();renderNotice();updateControls();flushQueue();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
bootstrap().catch(error=>{console.error(error);storageError(error);if(!state.graph){state.graph=cleanGraph();chain();renderChapter();}});
