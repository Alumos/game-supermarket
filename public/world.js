import { initialState, DELIVERY_MAP, TASKS, actionLabel } from '../shared/engine.mjs';

// One source pixel is kept visible at every scale. All art is drawn locally;
// classroom play needs no image host, font download, or rendering framework.
const WIDTH = 640, HEIGHT = 480, TILE = 28;
const FONT = '"PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const P = {ink:'#253c42',deep:'#244b50',teal:'#43867f',mint:'#8fc5ab',light:'#d5e1c8',cream:'#f4ead1',floor:'#e0d9bf',line:'#c7c5ac',white:'#fff7df',yellow:'#efc45c',orange:'#df8c49',red:'#bd6455',wood:'#a37a53',brown:'#765b43',shadow:'#395658'};
const XY = p => ({ x:32+p.x*TILE, y:24+p.y*TILE });
const GRID = p => ({x:Math.round((p.x-32)/TILE),y:Math.round((p.y-24)/TILE)});
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
const ITEMS = {a:{color:'#e39a48',name:'橙汁'},b:{color:'#dcad66',name:'饼干'},c:{color:'#e3e2cf',name:'纸巾'},d:{color:'#86acb5',name:'文具'},orange:{color:'#e69b46',name:'橙汁'},milk:{color:'#e6e8db',name:'牛奶'}};
const NODES = DELIVERY_MAP.points;
const WORK_POINTS = {'rice-roll':{x:3,y:9},tea:{x:8,y:9},plant:{x:13,y:9},fish:{x:18,y:9}};

export class SupermarketWorld {
  constructor(container,{onTarget,onInteract,onExplore}={}) {
    if (typeof container==='string') container=document.querySelector(container);
    if (!container) throw new Error('Scene container required');
    this.container=container; this.callbacks={onTarget,onInteract,onExplore};
    this.canvas=document.createElement('canvas'); this.canvas.className='supermarket-canvas';
    this.canvas.setAttribute('aria-label','超市像素地图，可点地面探路、点人物交谈');
    this.canvas.setAttribute('role','img'); this.canvas.tabIndex=0;
    this.canvas.style.cssText='display:block;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;touch-action:manipulation;outline:none';
    container.append(this.canvas); this.ctx=this.canvas.getContext('2d',{alpha:false});
    this.buffer=document.createElement('canvas'); this.buffer.width=WIDTH;this.buffer.height=HEIGHT;
    this.g=this.buffer.getContext('2d',{alpha:false});this.g.imageSmoothingEnabled=false;
    this.chapterId=1;this.taskId='drink-swap';this.mode='explore';this.routes=[];this.targets=[];this.trail=[];
    this.actor={x:10,y:13,face:'up',walk:0,moving:false};this.anim=null;this.paused=false;this.time=0;this.destroyed=false;
    this.pointerHandler=e=>this._pointer(e);this.keyHandler=e=>this._key(e);
    this.canvas.addEventListener('pointerdown',this.pointerHandler);window.addEventListener('keydown',this.keyHandler);
    this.resizeObserver=new ResizeObserver(()=>this._resize());this.resizeObserver.observe(container);
    this.setChapter(1,'drink-swap');this._resize();
    this.last=performance.now();this._frame=this._frame.bind(this);this.raf=requestAnimationFrame(this._frame);
  }
  setChapter(chapterId,taskId) {
    this.stop();this.chapterId=Number(chapterId)||1;
    this.taskId=taskId||['','drink-swap','fresh-juice','tea','delivery'][this.chapterId];
    this.state=clone(initialState(this.chapterId,this.taskId));this.initial=clone(this.state);
    Object.assign(this.actor,this.state.position||{x:10,y:13},{moving:false,face:'up',walk:0});
    this.trail=[];this.routes=[];this.flash=null;this._configure();
  }
  setState(state) {
    if(!state)return;this.state=clone(state);
    if(state.position&&!this.anim)Object.assign(this.actor,state.position);
  }
  setMode(mode){this.mode=mode||'explore';if(this.mode!=='explore'&&this.anim?.manual)this.stop();}
  setRoutes(routes){this.routes=Array.isArray(routes)?clone(routes):[];}
  setSelectTargets(targets){this.targets=Array.isArray(targets)?targets.map(t=>typeof t==='string'?t:t.id||t.value||t.target):[];}
  pause(){this.paused=true;}
  resume(){this.paused=false;this.last=performance.now();}
  stop(){if(this.anim){const a=this.anim;this.anim=null;this.actor.moving=false;a.resolve?.({cancelled:true});}this.paused=false;}
  reset(){this.stop();this.state=clone(this.initial);Object.assign(this.actor,this.state.position||{x:10,y:13},{moving:false,face:'up',walk:0});this.trail=[];this.flash=null;}
  destroy(){this.stop();this.destroyed=true;cancelAnimationFrame(this.raf);this.resizeObserver.disconnect();this.canvas.removeEventListener('pointerdown',this.pointerHandler);window.removeEventListener('keydown',this.keyHandler);this.canvas.remove();}
  capture(){return this.canvas.toDataURL('image/png');}
  playEvent(event,{speed=2}={}) {
    this.stop();if(!event)return Promise.resolve();
    const points=(event.path?.length?event.path:[event.from||{x:this.actor.x,y:this.actor.y},event.to||{x:this.actor.x,y:this.actor.y}]).map(p=>typeof p==='string'?NODES[p]:p).filter(p=>p&&Number.isFinite(p.x));
    if(event.type==='walk'&&points.length<2&&event.to)points.push(event.to);
    const length=points.slice(1).reduce((s,p,i)=>s+Math.hypot(p.x-points[i].x,p.y-points[i].y),0);
    const seconds=Math.max(.2,Number(event.duration)|| (event.type==='walk'?length*.38:.85));
    return new Promise(resolve=>{
      this.anim={event:clone(event),points,length,elapsed:0,duration:Math.max(200,seconds*1000/Math.max(.25,Number(speed)||2)),resolve,applied:false,startElapsed:Number(this.state.elapsed)||0};
      this.actor.moving=event.type==='walk';
      if(event.type==='walk'&&points.length)Object.assign(this.actor,points[0]);
      else this.flash={text:this._actionText(event),until:this.time+5};
    });
  }
  _configure(){
    this.hotspots=[];this.blocks=[];
    if(this.chapterId===1){
      this.hotspots=[{id:'A',x:5,y:9,label:'A · 饮料柜'},{id:'B',x:10,y:9,label:'B · 饮料柜'},{id:'C',x:15,y:9,label:'C · 周转位'}, {id:'clerk',x:3,y:12,label:'饮料柜员',npc:true}];
      this.blocks=[{x1:3,x2:6,y1:5,y2:8},{x1:8,x2:11,y1:5,y2:8},{x1:13,x2:16,y1:5,y2:8}];
    } else if(this.chapterId===2){
      this.hotspots=[{id:'station',x:10,y:9,label:'水果区 · 鲜榨橙汁台'},{id:'chef',x:5,y:11,label:'水果师傅',npc:true}];
      this.blocks=[{x1:7,x2:13,y1:5,y2:8},{x1:2,x2:5,y1:3,y2:5},{x1:15,x2:18,y1:4,y2:7}];
    } else if(this.chapterId===3){
      const names={'rice-roll':'饭卷',tea:'茶饮',plant:'绿植',fish:'观赏鱼'};
      this.hotspots=Object.entries(WORK_POINTS).map(([id,p])=>({id,...p,label:`${names[id]}工作台`}));
      this.hotspots.push({id:'mentor',x:3,y:12,label:({'rice-roll':'熟食师傅',tea:'茶饮师傅',plant:'园艺师傅',fish:'养护师傅'})[this.taskId]||'实践师傅',npc:true});
      this.blocks=Object.values(WORK_POINTS).map(p=>({x1:p.x-1,x2:p.x+1,y1:5,y2:8}));
    } else {
      this.hotspots=Object.entries(NODES).filter(([id])=>id==='W'||/^[A-I]$/.test(id)).map(([id,p])=>({id,...p,label:`${id}（${p.x},${p.y}）`}));
    }
  }

  _resize(){
    const box=this.container.getBoundingClientRect();this.cssScale=Math.min(box.width/WIDTH,box.height/HEIGHT)||1;const ratio=Math.min(2,window.devicePixelRatio||1);
    this.pixelRatio=ratio;this.canvas.width=Math.max(1,Math.round(box.width*ratio));this.canvas.height=Math.max(1,Math.round(box.height*ratio));
    this.ctx.imageSmoothingEnabled=false;
  }
  _frame(now){
    if(this.destroyed)return;const dt=Math.min(80,now-this.last);this.last=now;
    if(!this.paused){this.time+=dt/1000;this._advance(dt);}
    this._draw();this.raf=requestAnimationFrame(this._frame);
  }
  _advance(dt){
    const a=this.anim;if(!a)return;a.elapsed+=dt;const t=Math.min(1,a.elapsed/a.duration);
    if(a.event.type==='walk'){
      if(!a.manual&&this.chapterId===4&&Number.isFinite(a.event.state?.elapsed))this.state.elapsed=a.startElapsed+(a.event.state.elapsed-a.startElapsed)*t;
      let d=t*a.length,index=0;for(;index<a.points.length-1;index++){const p=a.points[index],q=a.points[index+1],len=Math.hypot(q.x-p.x,q.y-p.y);if(d<=len||index===a.points.length-2){const u=len?Math.min(1,d/len):1;const nx=p.x+(q.x-p.x)*u,ny=p.y+(q.y-p.y)*u;const dx=nx-this.actor.x,dy=(ny-this.actor.y)*(this.chapterId===4?-1:1);if(Math.abs(dx)+Math.abs(dy)>.0001)this.actor.face=Math.abs(dx)>Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'down':'up');Object.assign(this.actor,{x:nx,y:ny,walk:a.elapsed/120,moving:true});if(!a.manual&&this.chapterId===4){const last=this.trail[this.trail.length-1];if(!last||Math.hypot(last.x-nx,last.y-ny)>.35)this.trail.push({x:nx,y:ny});}break;}d-=len;}
    }else if(!a.applied&&t>=.65){a.applied=true;if(a.event.state)this.state=clone(a.event.state);}
    if(t>=1){
      if(a.event.state)this.state=clone(a.event.state);
      if(a.points.length&&a.event.type==='walk')Object.assign(this.actor,a.points[a.points.length-1]);
      if(a.event.state?.position&&!a.manual)Object.assign(this.actor,a.event.state.position);
      this.actor.moving=false;this.anim=null;a.resolve?.({cancelled:false});
      if(a.onDone)a.onDone();
    }
  }
  _walkable(p){
    if(this.chapterId===4)return DELIVERY_MAP.links.some(([a,b])=>{a=NODES[a];b=NODES[b];return a.x===b.x?p.x===a.x&&p.y>=Math.min(a.y,b.y)&&p.y<=Math.max(a.y,b.y):p.y===a.y&&p.x>=Math.min(a.x,b.x)&&p.x<=Math.max(a.x,b.x);});
    return p.x>=1&&p.x<=19&&p.y>=4&&p.y<=14&&!this.blocks.some(b=>p.x>=b.x1&&p.x<=b.x2&&p.y>=b.y1&&p.y<=b.y2);
  }
  _path(start,end){
    start={x:Math.round(start.x),y:Math.round(start.y)};end={x:Math.round(end.x),y:Math.round(end.y)};
    if(!this._walkable(end)){
      let near=null,dist=Infinity;for(let y=0;y<=15;y++)for(let x=0;x<=20;x++){const p={x,y},d=Math.hypot(x-end.x,y-end.y);if(this._walkable(p)&&d<dist){near=p;dist=d;}}end=near||start;
    }
    const queue=[start],seen=new Set([`${start.x},${start.y}`]),prev=new Map();let found=false;
    for(let i=0;i<queue.length;i++){const p=queue[i];if(p.x===end.x&&p.y===end.y){found=true;break;}for(const [dx,dy]of [[0,1],[1,0],[-1,0],[0,-1]]){const q={x:p.x+dx,y:p.y+dy},key=`${q.x},${q.y}`;if(this._walkable(q)&&!seen.has(key)){seen.add(key);prev.set(key,p);queue.push(q);}}}
    if(!found)return [start];const result=[end];let p=end;while(p.x!==start.x||p.y!==start.y){p=prev.get(`${p.x},${p.y}`);if(!p)break;result.unshift(p);}return result;
  }
  _explore(p,done){
    if(this.mode!=='explore')return;this.stop();const points=this._path(this.actor,p);const length=points.length-1;
    const destination=points.at(-1);this.flash={text:this.chapterId===4?`探路（${destination.x},${destination.y}）`:'探路中 · 不改变任务状态',until:this.time+1.3};
    this.anim={event:{type:'walk'},points,length,elapsed:0,duration:Math.max(160,length*135),manual:true,resolve:()=>{},onDone:done};this.actor.moving=length>0;
    this.callbacks.onExplore?.({x:points.at(-1).x,y:points.at(-1).y});
  }
  _screenPoint(e){
    const r=this.canvas.getBoundingClientRect(),{view,scaleX,scaleY,ox,oy}=this._projection(r.width,r.height);
    return {x:(e.clientX-r.left-ox)/scaleX+view.x,y:(e.clientY-r.top-oy)/scaleY,scale:Math.min(scaleX,scaleY),scaleX,scaleY};
  }
  _pointer(e){
    if(e.button&&e.button!==0)return;this.canvas.focus({preventScroll:true});const p=this._screenPoint(e);
    const matches=this.hotspots.map(h=>{const s=this._hotpoint(h);return {h,dx:Math.abs(p.x-s.x),dy:Math.abs(p.y-s.y),d:Math.hypot(p.x-s.x,p.y-s.y)};}).sort((a,b)=>a.d-b.d);
    const rangeX=Math.max(22/p.scaleX,25),rangeY=Math.max(22/p.scaleY,25);
    const workstation=this.chapterId===3?this.hotspots.find(h=>{if(h.npc)return false;const point=this._xy(h);return Math.abs(p.x-point.x)<=56&&p.y>=point.y-151&&p.y<=point.y+12;}):null;
    const hit=workstation||matches.find(m=>m.dx<=rangeX&&m.dy<=rangeY)?.h;
    if(this.mode==='select'){
      if(hit&&!hit.npc&&(!this.targets.length||this.targets.includes(hit.id))){this.flash={text:`已选择 ${hit.label}`,until:this.time+1.4};this.callbacks.onTarget?.(hit.id);}return;
    }
    if(hit){
      this.flash={text:hit.label,until:this.time+2};
      if(this.mode==='explore'&&hit.npc)this._explore(this.chapterId===4?NODES.W:{x:hit.x+1,y:hit.y},()=>this.callbacks.onInteract?.(hit.id));
      else if(this.mode==='explore')this._explore({x:hit.x,y:hit.y},()=>this.callbacks.onInteract?.(hit.id));
      return;
    }
    if(this.mode==='explore'&&p.x>=0&&p.x<=WIDTH&&p.y>=0&&p.y<=HEIGHT)this._explore(this._grid(p));
  }
  _key(e){
    if(this.mode!=='explore'||e.altKey||e.metaKey||e.ctrlKey)return;
    if(e.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    const delta={ArrowUp:[0,-1],w:[0,-1],W:[0,-1],ArrowDown:[0,1],s:[0,1],S:[0,1],ArrowLeft:[-1,0],a:[-1,0],A:[-1,0],ArrowRight:[1,0],d:[1,0],D:[1,0]}[e.key];
    if(!delta)return;e.preventDefault();if(this.anim)return;const p={x:Math.round(this.actor.x)+delta[0],y:Math.round(this.actor.y)+delta[1]*(this.chapterId===4?-1:1)};if(this._walkable(p))this._explore(p);
  }
  _view(){return this.chapterId===4?{x:88,width:464}:{x:0,width:WIDTH};}
  _projection(width,height){
    const view=this._view(),scaleX=Math.min(width/view.width,height/HEIGHT);
    // A tall map column in a landscape classroom layout may stretch vertically.
    // Text stays at scaleX and pointer coordinates use the same two axes.
    const landscape=window.innerWidth>window.innerHeight;
    const scaleY=landscape?Math.min(height/HEIGHT,scaleX*1.65):scaleX;
    return {view,scaleX,scaleY,ox:(width-view.width*scaleX)/2,oy:(height-HEIGHT*scaleY)/2};
  }
  _xy(p){return this.chapterId===4?{x:32+p.x*28,y:46+(DELIVERY_MAP.coordinateMaxY-p.y)*26}:XY(p);}
  _grid(p){return this.chapterId===4?{x:Math.round((p.x-32)/28),y:DELIVERY_MAP.coordinateMaxY-Math.round((p.y-46)/26)}:GRID(p);}
  _hotpoint(h){const p=this._xy(h);if(h.npc)return {x:p.x,y:p.y-23};if(this.chapterId===4)return {x:p.x,y:p.y};return {x:p.x,y:p.y+(this.chapterId===2?11:this.chapterId===1?-29:-15)};}
  _actionText(e){
    if(e.type==='delivery')return `${e.point} ${e.status==='spoiled'?'冷藏订单超时':'订单送达'} · ${e.coins>=0?'+':''}${e.coins||0}金币`;
    if(e.type==='take')return '拿起商品';
    if(e.type==='place')return '放下商品';
    const label=actionLabel(e.actionId||e.type);
    return label==='未选择操作'?'正在操作':label;
  }
  // All art primitives round to source pixels; text is rendered after pixel art.
  r(x,y,w,h,c){this.g.fillStyle=c;this.g.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));}
  line(x,y,x2,y2,c,width=1,dash=[]){const g=this.g;g.strokeStyle=c;g.lineWidth=width;g.setLineDash(dash);g.beginPath();g.moveTo(Math.round(x)+.5,Math.round(y)+.5);g.lineTo(Math.round(x2)+.5,Math.round(y2)+.5);g.stroke();g.setLineDash([]);}
  text(s,x,y,size=12,c=P.ink,align='center',weight='600',halo=false){this.labels.push({s,x,y,size,c,align,weight,halo});}
  poly(points,c){const g=this.g;g.fillStyle=c;g.beginPath();points.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.closePath();g.fill();}
  shadow(x,y,w,h=9){this.g.fillStyle='#25454724';this.g.beginPath();this.g.ellipse(x,y,w/2,h/2,0,0,Math.PI*2);this.g.fill();}
  _draw(){
    this.labels=[];if(this.chapterId===4)this._outdoorBase();else this._base();if(this.chapterId===1)this._drink();else if(this.chapterId===2)this._juice();else if(this.chapterId===3)this._practice();else this._delivery();
    this._drawRoutes();this._hotspots();
    for(const h of this.hotspots.filter(h=>h.npc)){const p=this._xy(h);this._person(p.x,p.y,{npc:true,role:h.id});}
    const a=this._xy(this.actor);if(this.chapterId===4)this._courier(a.x,a.y);else this._person(a.x,a.y,{face:this.actor.face,walk:this.actor.walk,moving:this.actor.moving,holding:this.state.holding,inventory:this.state.inventory});
    this._foreground();
    const c=this.ctx,w=this.canvas.width,h=this.canvas.height,{view,scaleX,scaleY,ox,oy}=this._projection(w,h);
    c.fillStyle='#243e41';c.fillRect(0,0,w,h);c.imageSmoothingEnabled=false;c.drawImage(this.buffer,view.x,0,view.width,HEIGHT,ox,oy,Math.round(view.width*scaleX),Math.round(HEIGHT*scaleY));
    // System-font labels are drawn at the screen's native resolution, independently
    // of the pixel-art buffer, so Chinese stays legible on tablets and HiDPI screens.
    for(const l of this.labels){c.fillStyle=l.c;c.font=`${l.weight} ${this.chapterId===4?Math.max(l.size*scaleX,9*(this.pixelRatio||1)):l.size*scaleX}px ${FONT}`;c.textAlign=l.align;c.textBaseline='middle';const tx=ox+(l.x-view.x)*scaleX,ty=oy+l.y*scaleY;if(l.halo){c.strokeStyle='#c6d1b1';c.lineWidth=Math.max(2,3*scaleX);c.lineJoin='round';c.strokeText(l.s,tx,ty);}c.fillText(l.s,tx,ty);}
  }
  _base(){
    this.r(0,0,WIDTH,HEIGHT,'#29464a');this.r(10,10,620,458,'#1e363d');this.r(16,14,608,448,P.deep);this.r(22,18,596,438,P.floor);
    // Enamel wall, tiled skirting, skylights, and the same store identity in every room.
    this.r(22,18,596,81,'#83b0a0');this.r(22,18,596,4,'#b8d4ba');
    for(let y=27;y<94;y+=14)for(let x=24+(y%3)*5;x<618;x+=42){this.r(x,y,40,12,(x+y)%4?'#a6c4af':'#9cbaa6');this.r(x,y,40,1,'#c0d4ba');}
    this.r(22,86,596,13,P.teal);this.r(22,85,596,2,'#e6d5a3');this.r(22,98,596,5,'#284f50');
    this.g.save();this.g.beginPath();this.g.rect(22,104,596,346);this.g.clip();
    for(let y=104;y<450;y+=TILE)for(let x=22;x<615;x+=TILE){const alt=((x-22)/TILE+(y-104)/TILE)%2;this.r(x,y,27,27,alt?'#e3ddc6':'#ddd7be');this.r(x+2,y+2,23,1,'#f4ecd4');if((x+y)%7===0)this.r(x+19,y+20,4,1,'#d4cfb7');}
    this.g.restore();
    this.r(22,104,6,346,'#b5bca4');this.r(612,104,6,346,'#c4c5ac');
    for(const x of [52,474]){this.r(x,35,114,34,P.deep);this.r(x+3,37,108,28,'#c5dfd1');this.r(x+5,39,104,12,'#e6f0d4');this.r(x+53,38,3,29,'#86b1a5');this.r(x+6,62,104,2,'#a9d2c1');this.r(x+9,42,20,2,'#fffbe4');}
    this.r(212,30,216,48,'#315c59');this.r(216,33,208,41,'#e7d8ac');this.r(220,36,200,35,P.deep);this.r(220,36,200,2,'#659a87');
    this.text('有序超市 · 社区门店',320,48,14,P.white);this.text(['','01  饮料陈列区','02  水果区 · 鲜榨橙汁','03  生活实践角','04  社区配送'][this.chapterId],320,65,10,'#c2dac0');
    for(const x of [44,592]){this.r(x-3,80,6,13,'#567f70');this.r(x-13,77,26,5,'#e8e1b9');this.r(x-10,82,20,2,'#fff6d6');}
    this.r(22,444,596,12,'#659085');this.r(22,444,596,2,'#afc6aa');
    // Floor boundary and the open entrance establish the small cutaway room.
    this.r(22,452,242,7,P.deep);this.r(376,452,242,7,P.deep);this.r(262,447,115,12,'#b7bd9f');this.r(266,449,107,2,'#ece2bf');
    this.r(281,417,78,25,'#749a88');this.r(284,420,72,19,'#80a991');this.text('WELCOME',320,429,9,'#d9e2b9');
    if(this.chapterId!==4){this._plant(57,400,1.15);this._plant(584,405,1.35);this._basket(80,424);this._basket(552,425);}
  }
  _cabinet(x,y,w=90,h=69,color=P.teal){
    this.shadow(x+w/2,y+h+5,w+12,13);this.r(x,y,w,h,P.deep);this.r(x+3,y+3,w-6,h-8,color);this.r(x+4,y+4,w-8,4,'#a6c2aa');this.r(x+4,y+h-12,w-8,9,'#356260');this.r(x+2,y+h,w-4,5,'#264d50');
    for(const p of [x+8,x+w-11])this.r(p,y+h+2,4,5,P.ink);
  }
  _shelf(x,y,w=90,theme=0){
    this._cabinet(x,y,w,68,['#709f8e','#b99d71','#83a5a3'][theme%3]);
    const colors=[['#e6a255','#c4664b','#f1d889'],['#d9ddca','#9abbb4','#e2c17c'],['#8db7b8','#d8c783','#bf856c']][theme%3];
    for(let row=0;row<2;row++){
      for(let i=0;i<Math.floor((w-14)/12);i++){const bx=x+9+i*12,by=y+12+row*26,c=colors[(i+row)%3];if(theme===0)this._bottle(bx,by,c);else if(theme===1)this._package(bx-2,by+2,9,15,c);else {this.r(bx-2,by+4,9,13,c);this.r(bx-2,by+4,9,3,'#cce0cb');this.r(bx,by+10,5,3,'#f7ebc9');}}
      this.r(x+4,y+34+row*26,w-8,4,'#d5d4ac');this.r(x+4,y+38+row*26,w-8,2,'#4d7470');
      for(let i=0;i<3;i++){this.r(x+12+i*25,y+35+row*26,13,2,'#fff4d5');this.r(x+15+i*25,y+35+row*26,5,1,'#d9855c');}
    }
  }
  _bottle(x,y,c){this.r(x,y,5,3,'#d6ddc6');this.r(x-1,y+3,7,4,c);this.r(x-2,y+7,9,12,c);this.r(x-1,y+9,7,5,'#f2e5bf');this.r(x,y+4,2,5,'#ffffff55');this.r(x,y+18,6,1,'#5f7b6755');}
  _package(x,y,w,h,c){this.r(x,y,w,h,c);this.r(x,y,w,2,'#f4e8c6');this.r(x+2,y+5,w-4,Math.max(2,h-9),'#fff0c8');this.r(x+3,y+6,Math.max(2,w-6),2,'#bf865c');this.r(x+w-1,y+2,1,h-2,'#62766b55');}
  _crate(x,y,item,small=false){
    const meta=ITEMS[item]||ITEMS.a,w=small?17:33,h=small?14:25;
    this.r(x-w/2,y-h,w,h,'#815f43');this.r(x-w/2+1,y-h+1,w-2,h-3,meta.color);this.r(x-w/2+2,y-h+2,w-4,3,'#f4d69b');this.r(x-2,y-h+1,4,h-3,'#b98f5b');
    this.r(x-w/2+3,y-h/2,w-6,small?5:9,'#f5ead0');
    if(!small)this.text(meta.name,x,y-h/2+4,8,'#795d43');
    this.r(x-w/2+2,y-3,w-4,2,'#805d4166');this.r(x-w/2+2,y-h+5,2,3,'#fff0bf');
  }
  _marker(id,x,y,color=P.deep,sub){
    const w=Math.max(34,id.length*16+12);this.r(x-w/2,y-12,w,24,'#fff2cf');this.r(x-w/2+2,y-10,w-4,20,color);this.r(x-w/2+2,y-10,w-4,2,'#ffffff33');this.text(id,x,y,15,'#fff6d9');if(sub)this.text(sub,x,y+24,11,P.deep);
  }
  _drink(){
    this._shelf(61,120,111,0);this._shelf(467,120,111,1);
    this._sign('清凉饮料',116,113,'#de9b4d');this._sign('每日鲜奶',522,113,'#76a9aa');
    for(const [id,gx]of [['A',5],['B',10],['C',15]]){
      const p=this._xy({x:gx,y:9});this._cabinet(p.x-49,p.y-104,98,66,id==='C'?'#aaad87':'#75aa9c');
      this.r(p.x-42,p.y-94,84,39,'#d6e0c2');this.r(p.x-40,p.y-91,80,3,'#e9efd6');
      const item=this.state.slots?.[id];if(item){this._crate(p.x,p.y-54,item);for(let i=0;i<4;i++)this._bottle(p.x-29+i*18,p.y-91,item==='milk'?'#e9ead9':'#e1a053');}
      else {this.r(p.x-22,p.y-82,44,24,'#b7ccb5');this.text('空 位',p.x,p.y-70,12,'#6e9584');this.line(p.x-20,p.y-59,p.x+20,p.y-59,'#9caf99');}
      this._marker(id,p.x,p.y-29,id==='C'?'#9c8662':P.deep);
      this.r(p.x-35,p.y+8,70,5,'#c4ba92');for(let k=-1;k<=1;k++)this.r(p.x+k*22-4,p.y+9,8,2,'#e6d6a5');
    }

    this._register(75,331);this._plant(553,336,.75);
  }
  _sign(label,x,y,color=P.teal,w=102){this.r(x-w/2-2,y-11,w+4,25,P.deep);this.r(x-w/2,y-9,w,21,color);this.r(x-w/2,y-9,w,2,'#ffffff44');this.text(label,x,y+1,11,P.white);}
  _register(x,y){this._cabinet(x-23,y-21,46,32,'#a8916c');this.r(x-15,y-39,28,21,P.deep);this.r(x-12,y-36,22,14,'#9fc7a6');this.r(x-4,y-18,6,7,'#54716b');this.r(x-16,y-6,30,6,'#e1d4ac');for(let i=0;i<4;i++)this.r(x-11+i*7,y-4,4,2,'#889482');}
  _orange(x,y,cut=false){
    if(cut){this.poly([[x-13,y+7],[x+13,y+7],[x+10,y-9],[x,y-13],[x-10,y-9]],'#e99e43');this.r(x-9,y-7,18,12,'#ffd37a');this.line(x,y-8,x,y+4,'#fff0b5',2);this.line(x-7,y-5,x+6,y+3,'#fff0b5',1);}
    else {this.r(x-11,y-8,22,18,'#db8a35');this.r(x-8,y-12,16,26,'#e99c40');this.r(x-5,y-8,14,18,'#efab4b');this.r(x-7,y-7,4,4,'#ffce75');this.r(x-1,y-14,3,4,'#7b8250');this.r(x+2,y-15,8,4,'#769456');}
  }
  _juice(){
    const f=this.state.flags||{},washed=f.wash_orange||f.wash,cut=f.peel_cut||f.cut_orange||f.peel,loaded=f.load_orange||f.add_orange||f.load,blended=f.juice||f.blend||f.start_juicer,packed=f.pack_juice||f.pack;
    this._sign('水果区 · 每日鲜榨',320,115,'#bd8145',214);
    this._cabinet(58,151,126,100,'#9eac7b');this.r(64,156,114,48,'#c5cf9d');
    for(let i=0;i<6;i++)this._orange(78+(i%3)*38,170+Math.floor(i/3)*25);
    this.text('新鲜甜橙',121,230,13,P.deep);
    this._cabinet(220,172,204,111,'#80aaa0');this.r(215,167,214,12,'#dce0be');
    this.r(230,183,83,66,'#c4cdb0');this.r(237,190,69,51,'#6f9e97');this.r(241,195,61,42,'#9dc7ba');this.r(255,180,8,17,'#e3dfc2');this.r(259,178,24,6,'#dbe4c7');this.r(279,181,5,13,'#e8e5ce');
    if(!cut&&!loaded&&!packed){this._orange(269,218);if(washed){for(let i=0;i<7;i++){this.r(252+i*6,197+(i%3)*8,2,5,'#e4f7dc');}this.text('已清洗',270,257,12,P.teal);}}
    this.r(330,202,74,43,'#e2c592');this.r(333,205,68,36,'#f0d7a6');
    if(cut&&!loaded&&!packed){this._orange(349,222,true);this._orange(384,221,true);this.r(385,185,5,18,'#526c66');this.r(365,199,24,4,'#d7dec4');this.text('橙肉切块',368,257,12,P.deep);}
    this._cabinet(454,173,116,110,'#88aa94');this.r(465,251,94,14,'#e7dfbd');
    this.r(485,171,52,71,'#315b58');this.r(489,177,44,59,'#bfd9bd');this.r(494,182,34,48,blended&&!packed?'#efb347':'#dce5c8');this.r(480,167,62,9,'#4f7e70');this.r(487,161,48,7,'#799d81');
    if(loaded&&!blended&&!packed){for(let i=0;i<6;i++)this.r(497+(i%3)*10,211-Math.floor(i/3)*12,8,9,'#eaa146');}
    const running=this.anim?.event.actionId==='start_juicer'||this.anim?.event.actionId==='juice'||this.anim?.event.actionId==='blend';
    if(blended&&!packed){for(let i=0;i<7;i++)this.r(496+(i*9)%29,188+(i*7+Math.floor(this.time*(running?22:0)))%34,3,2,'#ffda85');}
    this.r(492,241,38,13,'#5d8776');this.r(515,245,6,4,blended?'#efd26d':'#b3c89e');
    this.text(packed?'橙汁已倒出打包':blended?'已榨出橙汁':loaded?'橙肉已入机':'等待放入橙肉',512,294,12,P.deep);
    this.r(239,319,165,37,'#c9b98b');this.r(246,322,151,27,'#e8d9b1');
    if(packed){this.r(291,297,51,51,'#f5e9c7');this.r(296,303,41,39,'#edb44c');this.r(288,294,57,8,'#46776c');this.r(310,278,5,19,'#e9d7a5');this.r(298,315,37,18,'#fff0d1');this.text('鲜橙汁',317,324,11,'#9d6f3b');this._sign('✓ 已打包',320,375,'#56897b',130);}
    else this.text('成品打包位',320,337,13,'#7c825e');
    const completed=[washed,cut,loaded,blended,packed],steps=TASKS.find(task=>task.id==='fresh-juice').actions;
    steps.forEach(({label},i)=>{
      const x=92+i*114,done=completed[i],color=done?'#fff1d0':'#6d7968',chars=Array.from(label);
      this.r(x-47,391,94,37,done?'#578675':'#d2ccac');this.text(done?'✓':String(i+1),x-35,409,12,color);
      if(chars.length>4){this.text(chars.slice(0,4).join(''),x+8,402,12,color);this.text(chars.slice(4).join(''),x+8,416,12,color);}
      else this.text(label,x+8,409,12,color);
    });
  }
  _riceRoll(x,y,f={}){
    this.r(x-43,y-96,86,45,'#d6bf8d');for(let q=x-41;q<x+42;q+=4)this.r(q,y-93,1,38,'#b29162');
    this.r(x-43,y-118,26,18,'#e4ddbc');this.r(x-40,y-115,20,12,'#f5eccb');this.r(x+18,y-118,25,18,'#b4c393');for(let i=0;i<4;i++)this.r(x+21,y-115+i*3,19,2,i%2?'#d99860':'#78945c');
    if(f.seaweed){this.r(x-34,y-89,68,29,'#3f6548');this.r(x-30,y-85,60,21,'#52734e');}
    if(f.rice){this.r(x-29,y-85,58,20,'#f3edcf');for(let i=0;i<24;i++)this.r(x-26+(i*11)%51,y-82+(i*7)%15,2,1,'#d4d1ad');}
    if(f.filling){this.r(x-24,y-79,48,3,'#d68a57');this.r(x-24,y-74,48,3,'#e6b65e');this.r(x-24,y-69,48,2,'#759857');}
    if(f.roll){this.r(x-34,y-91,68,33,'#d4bd88');this.r(x-29,y-81,58,17,'#3c6149');this.r(x-25,y-79,50,3,'#799365');this.r(x-30,y-77,5,10,'#eee2b8');}
    if(f.pack){this.r(x-39,y-94,78,38,'#eee1bc');this.r(x-35,y-91,70,31,'#fff0cc');for(let i=0;i<5;i++){this.r(x-30+i*13,y-85,10,20,'#3d6148');this.r(x-28+i*13,y-83,6,16,'#ede2bf');this.r(x-26+i*13,y-79,3,7,'#cc9159');}}
  }
  _practice(){
    const f=this.state.flags||{},names={'rice-roll':'饭卷',tea:'茶饮',plant:'绿植',fish:'观赏鱼'};
    for(const [id,p]of Object.entries(WORK_POINTS)){
      const {x,y}=this._xy(p),active=id===this.taskId;
      if(active){this.r(x-60,y-144,120,151,'#ecd48c');this.r(x-57,y-141,114,145,'#a9c5a2');}
      this._cabinet(x-52,y-110,104,85,id==='plant'?'#a0aa7a':'#75a69a');
      this._sign(names[id],x,y-135,active?'#bc8d44':P.teal,100);
      this._marker(active?'当前任务':'点击选择',x,y-5,active?'#b7853f':'#64887b');
      if(active)this.text('↓ 在这里实践',x,y+28,13,'#765b30');
    }
    const rice=this._xy(WORK_POINTS['rice-roll']);this._riceRoll(rice.x,rice.y,this.taskId==='rice-roll'?f:{});
    const tea=this._xy(WORK_POINTS.tea),tf=this.taskId==='tea'?f:{};
    this.r(tea.x-45,tea.y-105,90,57,'#b7cbb0');this._kettle(tea.x-27,tea.y-62);
    this.r(tea.x+28,tea.y-103,13,34,'#ad8b58');this.r(tea.x+29,tea.y-102,11,4,'#d9bf85');
    if(tf.cup){const cx=tea.x+5,cy=tea.y-62;this.r(cx-11,cy-27,24,25,'#fff1d6');this.r(cx-8,cy-23,18,18,tf.water?(tf.steep?'#bb8c4f':'#e3dfb9'):'#d8ddbd');this.r(cx+13,cy-22,6,15,'#eee4c7');if(!tf.remove_bag){this.r(cx-4,cy-19,10,10,tf.steep?'#927045':'#b79f72');this.line(cx,cy-26,cx+10,cy-32,'#efe4bd');this.r(cx+9,cy-33,7,6,'#c98b4c');}if(tf.lid){this.r(cx-13,cy-29,28,6,'#5b8978');this.r(cx-8,cy-32,18,4,'#86b39c');this.r(cx-7,cy-18,17,10,'#fff1d6');this.r(cx-4,cy-15,11,2,'#548474');this.r(cx-4,cy-11,7,1,'#9e855c');}else if(tf.water){for(let i=0;i<2;i++)this.r(cx-3+i*9,cy-38-((this.time*8+i*7)%12),2,5,'#eef3d4aa');}}
    const plant=this._xy(WORK_POINTS.plant),pf=this.taskId==='plant'?f:{};
    this.r(plant.x-45,plant.y-105,90,57,'#d1d0aa');this._package(plant.x-41,plant.y-99,19,27,'#8f9968');this.text('土',plant.x-31,plant.y-87,11,'#fff2cf');this._watering(plant.x+30,plant.y-62);
    this.r(plant.x-12,plant.y-75,28,23,'#ba8760');this.r(plant.x-15,plant.y-79,34,6,'#d6a16c');this.r(plant.x-9,plant.y-75,22,3,pf.soil||pf.fill?'#795b3c':'#6b7d64');
    if(pf.plant){this.r(plant.x-6,plant.y-82,16,9,'#79593b');this.line(plant.x-3,plant.y-79,plant.x+6,plant.y-75,'#c1a375');this.line(plant.x+5,plant.y-80,plant.x+1,plant.y-74,'#c1a375');this._leaves(plant.x+2,plant.y-78,.8);}else this._plant(plant.x+29,plant.y-98,.4);
    if(pf.fill){this.r(plant.x-8,plant.y-77,6,2,'#5c4d34');this.r(plant.x+7,plant.y-77,6,2,'#8c6c43');}
    if(pf.water_plant){this.r(plant.x-7,plant.y-76,20,2,'#67553b');this.r(plant.x+13,plant.y-100,2,5,'#7ab5c0');this.r(plant.x-11,plant.y-95,2,3,'#7ab5c0');}
    if(pf.label_plant){this.r(plant.x+13,plant.y-104,2,29,'#90754f');this.r(plant.x+8,plant.y-109,23,12,'#fff0c8');this.r(plant.x+11,plant.y-105,15,2,'#87a06e');}
    const fish=this._xy(WORK_POINTS.fish),ff=this.taskId==='fish'?f:{};
    this._tank(fish.x-43,fish.y-111,86,62,ff.feed);
    if(ff.open_feed&&!ff.close_feed){this.r(fish.x-45,fish.y-116,41,6,'#315c5a');this.r(fish.x+22,fish.y-116,23,6,'#315c5a');this.poly([[fish.x-4,fish.y-118],[fish.x+22,fish.y-118],[fish.x+17,fish.y-128],[fish.x-8,fish.y-128]],'#4a7b71');}
    else this.r(fish.x-45,fish.y-116,90,6,'#315c5a');
    if(ff.fishfood){this.r(fish.x+23,fish.y-72,19,5,'#e9dcc0');this.r(fish.x+25,fish.y-67,15,5,'#b89363');if(!ff.feed)for(let i=0;i<5;i++)this.r(fish.x+26+i*3,fish.y-75+(i%2)*2,2,2,'#d1a555');}
    if(ff.feed)for(let i=0;i<6;i++)this.r(fish.x+2+(i*3)%13,fish.y-106+(i*5+Math.floor(this.time*6))%25,2,2,'#e9c377');
    if(ff.record_feed){this.r(fish.x+12,fish.y-47,26,18,'#f2e4bd');this.r(fish.x+15,fish.y-42,17,1,'#86a27b');this.r(fish.x+15,fish.y-37,13,1,'#86a27b');this.text('✓',fish.x+32,fish.y-34,11,P.teal);}
    this._sign('点工作台选择任务 · 每个区的流程图分别保存',335,375,'#4a776b',370);
  }
  _kettle(x,y){this.r(x-12,y-24,22,22,'#88a69b');this.r(x-11,y-24,20,3,'#dce0bd');this.r(x-8,y-28,14,5,'#436d66');this.r(x-2,y-31,3,3,'#bed1ac');this.poly([[x+9,y-19],[x+21,y-26],[x+16,y-12],[x+9,y-10]],'#7fa293');this.r(x-18,y-20,7,16,'#436f67');this.r(x-17,y-18,4,11,'#c2d1af');this.r(x-7,y-18,3,12,'#c3d4b5');}
  _watering(x,y){this.r(x-11,y-16,18,15,'#7ba5a6');this.r(x-8,y-17,12,3,'#c1d2bc');this.poly([[x+6,y-11],[x+19,y-19],[x+20,y-16],[x+8,y-4]],'#759b9a');this.r(x-17,y-15,7,12,'#759b9a');this.r(x-15,y-13,3,7,'#c1cbb0');}
  _tank(x,y,w,h,fed=false){
    this.r(x-2,y-2,w+4,h+6,'#315957');this.r(x,y,w,h,'#72b4b6');this.r(x+3,y+3,w-6,h-6,'#9bcebf');this.r(x+4,y+6,w-8,2,'#d1e7ce');this.r(x+4,y+h-10,w-8,7,'#d2c397');
    for(let i=0;i<7;i++)this.r(x+6+i*11,y+h-7+(i%3),4,2,'#a9ae7e');
    for(const [lx,ly]of [[10,42],[22,49],[68,47]]){this.r(x+lx,y+ly-14,2,16,'#5a9a78');this.r(x+lx-4,y+ly-12,5,3,'#6eaa83');this.r(x+lx+1,y+ly-8,6,3,'#75b08a');}
    for(let i=0;i<3;i++){const fx=x+19+((this.time*(fed?13:7)+i*23)%(w-33)),fy=y+19+(i*11)%24+Math.sin(this.time+i)*3;const fc=['#e5ac64','#e28b62','#e8d197'][i];this.r(fx,fy,11,6,fc);this.r(fx+2,fy-2,6,10,fc);this.poly([[fx,fy+3],[fx-5,fy-2],[fx-5,fy+8]],fc);this.r(fx+8,fy+1,1,2,'#365e5d');}
    this.r(x+5,y+9,2,h-19,'#d9edcf77');this.line(x+7,y+11,x+24,y+11,'#f2f3d777');
    for(let i=0;i<3;i++){const bx=x+w-11,by=y+h-11-((this.time*11+i*12)%(h-15));this.r(bx,by,3,3,'#d2ead1');this.r(bx+1,by+1,1,1,'#8bc3bc');}
  }
  _outdoorBase(){
    this.r(0,0,WIDTH,HEIGHT,'#28484b');this.r(12,12,616,456,'#436e60');this.r(18,18,604,444,'#b6c799');
    for(let y=24;y<459;y+=14)for(let x=23;x<620;x+=17){if((x+y)%4===0)this.r(x,y,3,2,'#91b085');else if((x+y)%7===0)this.r(x,y,2,4,'#cad2a4');}
    this.r(26,25,588,43,'#345d59');this.r(29,28,582,3,'#6e9c86');if(!this.flash||this.flash.until<=this.time)this.text('有序超市 · 社区配送',320,47,18,'#fff0cb');
    // Buildings sit between roads. All road cells below come from DELIVERY_MAP.
    // Keep the small lawn blocks open for address labels beside the road.
    for(const [x,y]of [[65,155],[565,156],[66,266],[567,273],[66,385],[565,388]]){this._plant(x,y,.8);this.r(x-13,y+16,26,3,'#8da984');}
    for(const [from,to]of DELIVERY_MAP.links){const a=this._xy(NODES[from]),b=this._xy(NODES[to]);this.line(a.x,a.y,b.x,b.y,'#789780',35);this.line(a.x,a.y,b.x,b.y,'#ecdfb8',29);this.line(a.x,a.y,b.x,b.y,'#b0b5a2',23);this.line(a.x,a.y,b.x,b.y,'#e6dec0',1,[9,8]);}
    const cells=new Map();
    for(const [from,to]of DELIVERY_MAP.links){const a=NODES[from],b=NODES[to],d=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);for(let i=0;i<=d;i++){const p={x:a.x+Math.sign(b.x-a.x)*i,y:a.y+Math.sign(b.y-a.y)*i};cells.set(`${p.x},${p.y}`,p);}}
    for(const p of cells.values()){const q=this._xy(p);this.r(q.x-1,q.y-1,3,3,'#f4ebcd');}
    // Street furniture is kept outside the coordinate lane.
    this.r(33,445,574,7,'#688b70');this.r(36,446,568,2,'#e5d5a7');
  }
  _house(x,y,color,roof){
    this.shadow(x,y+24,92,12);this.r(x-40,y-16,80,43,'#496c5c');this.r(x-37,y-18,74,41,color);this.poly([[x-47,y-20],[x-36,y-39],[x+29,y-39],[x+46,y-20]],roof);this.r(x-43,y-20,86,5,'#526f5e');this.r(x-30,y-31,59,2,'#ffffff33');this.r(x-10,y-2,20,25,'#6d8774');this.r(x-6,y+1,12,19,'#a1b49a');
    for(const q of [-25,24]){this.r(x+q-7,y-9,15,16,'#597e75');this.r(x+q-5,y-7,11,12,'#c6dfc0');this.r(x+q,y-7,1,12,'#7a9c87');this.r(x+q-5,y-2,11,1,'#7a9c87');}
  }
  _delivery(){
    const orders=this.state.orders||[];
    for(const id of ['A','B','C','D','E','F']){
      const node=NODES[id];if(!node)continue;const p=this._xy(node),order=orders.find(o=>o.point===id)||{},status=order.status||'pending';
      const cold=Boolean(order.cold),color=status==='delivered'?'#2d7656':status==='spoiled'?'#b14b43':cold?'#247d96':'#796541';
      // Cold deliveries breathe gently; the unfilled ring keeps the road visible.
      if(cold){
        const pulse=(Math.sin(this.time*1.8)+1)/2,radius=25+pulse*5;
        this.g.save();this.g.globalAlpha=status==='pending'?.3+pulse*.25:.3;
        this.g.strokeStyle=color;this.g.lineWidth=3;this.g.beginPath();this.g.ellipse(p.x,p.y,radius,radius*.75,0,0,Math.PI*2);this.g.stroke();this.g.restore();
      }
      this.shadow(p.x,p.y+12,34,7);this.r(p.x-14,p.y-12,28,25,'#f3eed3');this.r(p.x-11,p.y-10,22,20,color);
      this.text(id,p.x,p.y,17,'#fff7df');
      const labelX=p.x+66;
      if(cold)this.text('❄ 冷藏',labelX,p.y-35,17,color,'center','750',true);
      if(status!=='pending')this.text(status==='delivered'?'✓':'×',p.x+22,p.y-18,18,color,'center','800',true);
      else if(cold)this.text(`❄ ${order.deadline}分钟内`,labelX,p.y+30,14,color,'center','700',true);
    }
    for(const id of ['G','H','I']){const node=NODES[id];if(!node)continue;const p=this._xy(node);this.r(p.x-14,p.y-12,28,25,'#f3eed3');this.r(p.x-11,p.y-10,22,20,'#617b64');if(id==='H'){this.line(p.x+14,p.y-13,p.x+23,p.y-20,'#567966',1);this.text(id,p.x+30,p.y-24,18,'#365f4e','center','800',true);}else this.text(id,p.x,p.y,17,'#fff7df');}
    const w=this._xy(NODES.W);this.r(w.x-67,w.y-20,134,47,'#3d7166');this.r(w.x-72,w.y-25,144,9,'#e0bd78');for(let i=0;i<9;i++)this.r(w.x-70+i*16,w.y-24,8,8,i%2?'#f0d99f':'#d29d59');this.r(w.x-55,w.y-11,110,30,'#b4cfad');this.r(w.x-13,w.y-11,26,30,'#5c8e7c');this.r(w.x-10,w.y-8,20,24,'#a7ccba');
    this.text('W',w.x,w.y+36,18,'#315e53','center','800',true);
    const coordinateGroups=[['A','B','C','D','E'],['F','G','H','I','W']];
    coordinateGroups.forEach((ids,column)=>ids.forEach((id,row)=>{const point=NODES[id];if(point)this.text(`${id}（${point.x},${point.y}）`,column?398:101,359+row*16,17,P.deep,'left','700',true);}));
  }
  _courier(x,y){
    x=Math.round(x);y=Math.round(y);const moving=this.actor.moving,bob=moving?Math.round(Math.sin(this.actor.walk*Math.PI)*1.5):0;
    this.shadow(x,y+8,55,10);
    for(const q of [-17,17]){this.r(x+q-8,y-6,16,15,'#2c4c4b');this.r(x+q-5,y-3,10,9,'#b9c7ac');this.r(x+q-2,y-2,3,7,'#617f73');this.r(x+q-5,y+1,10,2,'#617f73');}
    this.line(x-17,y+1,x-4,y-15,'#bf9655',3);this.line(x-4,y-15,x+17,y+1,'#bf9655',3);this.line(x-17,y+1,x+10,y+1,'#bf9655',3);this.line(x+10,y+1,x-4,y-15,'#bf9655',3);this.line(x+17,y+1,x+13,y-20,'#466b60',3);this.line(x+10,y-20,x+20,y-20,'#466b60',3);
    this.r(x-8,y-23+bob,9,15,'#315c69');this.r(x-6,y-11+bob,13,5,'#315c69');this.r(x-3,y-8,11,4,'#284a4b');
    this.r(x-12,y-39+bob,21,20,'#e3bb68');this.r(x-9,y-39+bob,17,4,'#f2d392');this.r(x+7,y-33+bob,5,15,'#ddb282');this.r(x+9,y-23+bob,8,4,'#dfb78b');
    // An insulated box and helmet identify the courier even on a small tablet.
    this.r(x-28,y-40+bob,21,26,'#315f5d');this.r(x-26,y-38+bob,17,21,'#7da88f');this.r(x-25,y-36+bob,15,5,'#c4d4a9');this.r(x-21,y-29+bob,7,8,'#f0dab0');this.r(x-19,y-27+bob,3,4,'#709282');
    this.r(x-10,y-56+bob,18,17,'#e4bb90');this.r(x-11,y-58+bob,20,8,'#cb7551');this.r(x-7,y-62+bob,12,6,'#e7a26a');this.r(x-10,y-56+bob,19,2,'#f1c28a');this.r(x+5,y-48+bob,2,3,'#35544f');this.r(x+8,y-51+bob,4,5,'#e9c195');this.r(x+4,y-40+bob,5,3,'#bd8b68');
    if(this.anim?.event.type==='delivery'){const status=this.anim.event.status;this._sign(status==='spoiled'?'× 超时':'✓ 送达',x,y-80,status==='spoiled'?'#b55f50':'#497f64',92);}
  }
  _drawRoutes(){
    if(this.chapterId===4&&this.trail.length>1)this._route(this.trail,'#ddac58',false,2,.58);
    for(let i=0;i<this.routes.length;i++){const route=this.routes[i],pts=route.points||route.path||[];if(pts.length<2)continue;this._route(pts,route.color||['#e19d53','#538fa9'][i%2],route.dashed,3,.9,i*3-2);if(route.label){const p=this._xy(pts[0]);this._sign(route.label,p.x+(i?70:-70),p.y+60,route.color||P.teal,100);}}
  }
  _route(points,color,dashed,width=3,alpha=1,offset=0){const g=this.g;g.save();g.globalAlpha=alpha;g.strokeStyle=color;g.lineWidth=width;g.setLineDash(dashed?[7,5]:[]);g.lineJoin='round';g.beginPath();points.forEach((p,i)=>{if(typeof p==='string')p=NODES[p];if(!p)return;const a=this._xy(p);if(i)g.lineTo(a.x+offset,a.y+offset);else g.moveTo(a.x+offset,a.y+offset);});g.stroke();g.restore();}
  _hotspots(){
    const ratio=this.pixelRatio||1,{scaleX,scaleY}=this._projection(this.canvas.width/ratio,this.canvas.height/ratio),touchX=Math.max(44,44/scaleX),touchY=Math.max(44,44/scaleY);
    for(const h of this.hotspots){const p=this._xy(h),hp=this._hotpoint(h),eligible=this.mode==='select'&&!h.npc&&(!this.targets.length||this.targets.includes(h.id));
      if(eligible){const pulse=Math.sin(this.time*4)*2;this.g.fillStyle='#f7d77a24';this.g.fillRect(hp.x-touchX/2-pulse,hp.y-touchY/2-pulse,touchX+pulse*2,touchY+pulse*2);this.g.strokeStyle='#b78a42';this.g.lineWidth=2;this.g.setLineDash([5,3]);this.g.strokeRect(hp.x-touchX/2,hp.y-touchY/2,touchX,touchY);this.g.setLineDash([]);this.text('点选',hp.x,hp.y+touchY/2+10,11,'#8a6a3e');}
      if(h.npc){this.shadow(p.x,p.y+1,25);this.r(p.x-13,p.y-57,26,17,'#fff0c9');this.r(p.x-15,p.y-55,30,13,'#fff0c9');this.poly([[p.x-3,p.y-40],[p.x+4,p.y-40],[p.x,p.y-35]],'#fff0c9');this.text('···',p.x,p.y-48,15,P.teal);this.text(h.label,p.x,p.y+16,11,P.deep);}
    }
  }
  _person(x,y,{npc=false,role='',face='down',walk=0,moving=false,holding=null,inventory=[]}={}){
    x=Math.round(x);y=Math.round(y);const step=moving?Math.sin(walk*Math.PI)*2:0,bob=moving?Math.abs(Math.sin(walk*Math.PI)):-Math.sin(this.time*2)*.35;
    y=Math.round(y-bob);this.shadow(x,y+2,npc?23:27,8);
    const pants=npc?'#426c64':'#315970',shirt=npc?(role==='chef'?'#ece5cc':role==='warehouse'?'#b99560':role==='customer'?'#b27f6d':'#74a88a'):'#d8b166',hair=npc?'#554c3c':'#4a4439';
    this.r(x-7,y-13,6,11,pants);this.r(x+2,y-13,6,11,pants);this.r(x-8,y-3+step,7,5,P.ink);this.r(x+2,y-3-step,7,5,P.ink);this.r(x-8,y-3+step,5,1,'#71857a');this.r(x+3,y-3-step,5,1,'#71857a');
    this.r(x-10,y-28,20,18,P.ink);this.r(x-9,y-28,18,16,shirt);this.r(x-7,y-27,14,3,npc?'#c5d8b5':'#ecd294');
    if(face==='up'){this.r(x-7,y-23,14,10,npc?'#467b69':'#58887a');this.r(x-5,y-21,10,2,'#a9c2a1');}
    else {this.r(x-5,y-24,10,12,npc?'#e7d6a8':'#5c8b7b');this.r(x-4,y-23,8,2,'#c7d4ab');this.r(x+5,y-23,3,4,'#efdcaa');}
    const arm=holding||inventory?.length?0:step;
    this.r(x-13,y-25+arm,4,12,shirt);this.r(x+10,y-25-arm,4,12,shirt);this.r(x-13,y-16+arm,4,5,'#dfb48a');this.r(x+10,y-16-arm,4,5,'#dfb48a');
    this.r(x-9,y-45,18,17,P.ink);this.r(x-8,y-44,16,15,'#e4b98d');this.r(x-7,y-33,14,3,'#d09b76');
    if(face!=='up'){if(face!=='right')this.r(x-5,y-37,2,3,'#364847');if(face!=='left')this.r(x+3,y-37,2,3,'#364847');this.r(x-1,y-32,3,1,'#ad795c');if(face==='left')this.r(x-10,y-36,3,4,'#e7bf96');if(face==='right')this.r(x+8,y-36,3,4,'#e7bf96');}
    this.r(x-10,y-45,20,8,hair);this.r(x-9,y-39,3,6,hair);this.r(x+6,y-39,3,5,hair);this.r(x-6,y-45,12,2,'#6c6348');
    if(npc&&role==='chef'){this.r(x-11,y-48,22,6,'#fff2d8');this.r(x-8,y-53,16,8,'#fff2d8');this.r(x-3,y-56,8,6,'#fff2d8');this.r(x-10,y-46,20,2,'#b4c0a4');}
    else {this.r(x-10,y-48,20,6,npc?'#396e60':'#c96e4d');this.r(x-6,y-51,14,5,npc?'#5b8f72':'#de9160');this.r(x-9,y-48,17,1,npc?'#84ae89':'#ecb277');this.r(face==='left'?x-14:x-1,y-43,15,3,npc?'#325c55':'#a85844');}
    if(face==='up')this.r(x-7,y-42,14,12,hair);
    if(holding){this._crate(x,y-9,holding);this.r(x-18,y-23,5,6,'#e5bb90');this.r(x+13,y-23,5,6,'#e5bb90');}
    if(!npc&&this.anim&&this.anim.event.type!=='walk'){
      const t=this.anim.elapsed/this.anim.duration,ax=x+22,ay=y-26-Math.sin(t*Math.PI)*9;this.r(ax-4,ay-3,8,6,'#f2cd78');this.r(ax-1,ay-6,2,12,'#fff1bd');this.r(ax-6,ay-1,12,2,'#fff1bd');
    }
  }
  _leaves(x,y,s=1){
    this.r(x-1,y-28*s,2,29*s,'#53845c');const ls=[[-12,-14,12,6],[-14,-21,12,6],[-5,-32,9,10],[2,-25,12,6],[3,-13,13,6]];
    for(const [lx,ly,w,h]of ls){this.r(x+lx*s,y+ly*s,w*s,h*s,'#6e9d64');this.r(x+(lx+2)*s,y+(ly+1)*s,(w-4)*s,2*s,'#a6bf7e');this.r(x+(lx+3)*s,y+(ly+h-1)*s,(w-3)*s,1*s,'#4f8059');}
  }
  _plant(x,y,s=1){this.shadow(x,y+7,25*s);this.r(x-10*s,y,20*s,15*s,'#a77d55');this.r(x-12*s,y-3*s,24*s,6*s,'#c59d68');this.r(x-8*s,y+4*s,4*s,9*s,'#d4ab73');this.r(x-8*s,y-3*s,16*s,2*s,'#715a3c');this._leaves(x,y-3*s,s);}
  _basket(x,y){this.shadow(x,y+4,31);this.r(x-15,y-14,30,17,'#a4774c');this.r(x-17,y-16,34,5,'#d2a969');for(let i=0;i<6;i++)this.r(x-12+i*5,y-9,2,10,'#d5ac70');this.r(x-12,y-23,24,3,'#886941');this.r(x-14,y-22,3,9,'#886941');this.r(x+11,y-22,3,9,'#886941');}
  _foreground(){
    // Quiet status ribbon stays inside the scene and never substitutes for UI controls.
    const labels={explore:'自由探路',run:'按流程执行',select:'选择地点',locked:'观看现场'};
    const ry=this.chapterId===4?449:109,rx=this.chapterId===4?94:34;this.r(rx,ry,88,20,'#f7edcd');this.r(rx,ry,3,20,this.mode==='run'?'#d5a351':P.teal);this.text(labels[this.mode]||labels.explore,rx+46,ry+10,12,P.deep);
    if(this.chapterId===4){this.r(366,447,182,25,'#f3e8c6');this.text(`◷ ${Math.round(this.state.elapsed||0)}分钟   ● ${this.state.coins||0}金币`,457,460,14,P.deep);}
    if(this.paused){this.r(266,105,108,25,'#f7e8ba');this.text('Ⅱ  已暂停',320,118,12,'#8d6f3e');}
    if(this.flash&&this.flash.until>this.time){const delivery=this.chapterId===4,w=Math.min(delivery?420:320,Math.max(130,this.flash.text.length*12+28)),top=delivery?30:424;this.r(320-w/2,top,w,27,'#264c49');this.r(322-w/2,top+2,w-4,2,'#79a48a');this.text(this.flash.text,320,top+14,delivery?15:12,'#fff1cb');}
  }
}
