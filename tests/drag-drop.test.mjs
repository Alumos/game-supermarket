import test from 'node:test';
import assert from 'node:assert/strict';
import {dragFootprint,dropZone,insertionAt,movedInsertionIndex} from '../public/drag-drop.mjs';

const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height});
const editor=rect(200,100,400,600),palette=rect(630,100,180,600);
const node=(id,left,top,width=140,height=50)=>({id,rect:rect(left,top,width,height)});

test('majority of the card body accepts a panel, including headers and blank space',()=>{
  for(const footprint of [rect(250,105,100,50),rect(250,645,100,50),rect(155,250,180,50)])assert.equal(dropZone(footprint,editor,palette),'editor');
  for(const footprint of [rect(650,105,100,50),rect(650,645,100,50),rect(590,250,100,50)])assert.equal(dropZone(footprint,editor,palette),'palette');
  assert.equal(dropZone(null,editor,palette),null);
  assert.equal(dropZone(rect(250,250,0,50),editor,palette),null);
});

test('grabbing opposite ends produces the same area decision even with pointers in opposite panels',()=>{
  const size={width:320,height:50};
  for(const offset of [{x:10,y:25},{x:310,y:25}]){
    const body=dragFootprint({x:480+offset.x,y:275},offset,size);
    assert.equal(dropZone(body,editor,palette),'palette','most of the card is in tools even when the left grip is still in the editor');
    const retained=dragFootprint({x:360+offset.x,y:275},offset,size);
    assert.equal(dropZone(retained,editor,palette),'editor','most of the card is in the editor even when the right grip is in tools');
  }
});

test('half or a small corner cannot accept a drop; full two-dimensional area must exceed half',()=>{
  assert.equal(dropZone(rect(580,250,100,50),editor,palette),null,'exactly half in tools cancels');
  assert.equal(dropZone(rect(579,250,100,50),editor,palette),null,'49 percent in tools cancels');
  assert.equal(dropZone(rect(581,250,100,50),editor,palette),'palette','51 percent in tools accepts');
  assert.equal(dropZone(rect(590,80,100,100),editor,palette),null,'60 percent horizontal and 80 percent vertical overlap is only 48 percent total');
  assert.equal(dropZone(rect(100,250,180,50),editor,palette),null,'a small corner reaching the canvas does not add a block');
  assert.equal(dropZone(rect(850,750,100,50),editor,palette),null);
});

test('shrunk decimal footprints reject exactly half but accept 51 percent',()=>{
  const scale=.92,size={width:390*scale,height:56*scale},offset={x:7*scale,y:28*scale};
  const tools=rect(1220,80,204,676);
  for(const fraction of [.49,.5,.51]){
    const footprint=dragFootprint({x:tools.right-size.width*fraction+offset.x,y:170+offset.y},offset,size);
    assert.equal(dropZone(footprint,null,tools),fraction>.5?'palette':null,`${fraction*100}% of a fractional-size dragged block`);
  }
});

test('footprint retains the original grip offset',()=>{
  assert.deepEqual(dragFootprint({x:400,y:300},{x:12,y:20},{width:140,height:50}),rect(388,280,140,50));
});

test('vertical insertion honors both halves, terminal boundaries and the release coordinate',()=>{
  const nodes=[node('start',240,150),node('a',240,220),node('b',240,290),node('end',240,360)];
  assert.equal(insertionAt({x:260,y:298},null,nodes).index,2);
  assert.equal(insertionAt({x:260,y:333},null,nodes).index,3);
  assert.deepEqual(insertionAt({x:260,y:160},null,nodes),{index:1,targetId:'start',side:'after',axis:'y',direction:1});
  assert.deepEqual(insertionAt({x:260,y:400},null,nodes),{index:3,targetId:'end',side:'before',axis:'y',direction:1});
  // No cached hover state: release at the other end produces a new boundary.
  const hover=insertionAt({x:260,y:298},null,nodes),released=insertionAt({x:260,y:400},null,nodes);
  assert.notEqual(hover.index,released.index);
});

test('insertion follows the card center regardless of the original grip position',()=>{
  const nodes=[node('a',240,150),node('b',240,240)];
  const footprint=rect(240,235,140,50);
  const expected=insertionAt({x:250,y:160},footprint,nodes);
  assert.equal(expected.targetId,'b');
  assert.deepEqual(insertionAt({x:370,y:260},footprint,nodes),expected);
});

test('snake rows use horizontal direction, including right-to-left rows',()=>{
  const nodes=[node('start',200,100),node('a',380,100),node('b',380,200),node('c',200,200),node('end',200,300)];
  assert.deepEqual(insertionAt({x:390,y:120},null,nodes,{layout:'snake'}),{index:1,targetId:'a',side:'before',axis:'x',direction:1});
  assert.deepEqual(insertionAt({x:330,y:220},null,nodes,{layout:'snake'}),{index:3,targetId:'c',side:'before',axis:'x',direction:-1});
  assert.equal(insertionAt({x:210,y:220},null,nodes,{layout:'snake'}).side,'after');
});

test('moving at a target center follows travel direction and returning to source is a no-op',()=>{
  const nodes=[node('start',200,100),node('a',200,170),node('b',200,240),node('end',200,310)];
  assert.equal(insertionAt({x:270,y:265},null,nodes,{sourceId:'a'}).index,3);
  assert.equal(insertionAt({x:270,y:195},null,nodes,{sourceId:'b'}).index,1);
  const unchanged=insertionAt({x:215,y:190},null,nodes,{sourceId:'a'});
  assert.equal(movedInsertionIndex(1,unchanged.index,nodes.length),1);
});

test('a snapped side survives center jitter and switches after crossing the hysteresis margin',()=>{
  const nodes=[node('start',200,100),node('a',200,170),node('end',200,240)];
  let previous=insertionAt({x:270,y:180},null,nodes);
  for(const y of [193,198,204,185,205]){
    previous=insertionAt({x:270,y},null,nodes,{previous});
    assert.equal(previous.side,'before',`center at ${y} keeps the upper snap`);
  }
  previous=insertionAt({x:270,y:206},null,nodes,{previous});
  assert.equal(previous.side,'after');
  for(const y of [201,189,185]){
    previous=insertionAt({x:270,y},null,nodes,{previous});
    assert.equal(previous.side,'after',`center at ${y} keeps the lower snap`);
  }
  assert.equal(insertionAt({x:270,y:184},null,nodes,{previous}).side,'before');
  assert.equal(insertionAt({x:270,y:200},null,nodes,{previous,hysteresis:0}).side,'after','zero margin allows immediate crossing');
  assert.equal(insertionAt({x:270,y:204},null,nodes,{previous:{...previous,side:'before'},hysteresis:8}).side,'after','the margin can be tuned');
});

test('switching target resets the side even near its center in a multi-column vertical layout',()=>{
  const nodes=[node('start',200,100),node('a',200,170),node('b',380,170),node('end',380,240)];
  const previous=insertionAt({x:270,y:180},null,nodes);
  const next=insertionAt({x:450,y:198},null,nodes,{previous});
  assert.equal(next.targetId,'b');
  assert.equal(next.side,'after','previous before-side on a does not stick to b');
  assert.equal(next.axis,'y');
  assert.equal(next.index,3);
  const returned=insertionAt({x:270,y:192},null,nodes,{previous:next});
  assert.equal(returned.targetId,'a');
  assert.equal(returned.side,'before');
});

test('snake hysteresis follows reversed row direction and fixed terminal sides',()=>{
  const nodes=[node('start',200,100),node('a',380,100),node('b',380,200),node('c',200,200),node('end',200,300)];
  let previous=insertionAt({x:300,y:225},null,nodes,{layout:'snake'});
  assert.equal(previous.side,'before');
  previous=insertionAt({x:264,y:225},null,nodes,{layout:'snake',previous});
  assert.equal(previous.side,'before','moving left six pixels beyond the midpoint retains the snap');
  previous=insertionAt({x:259,y:225},null,nodes,{layout:'snake',previous});
  assert.equal(previous.side,'after');
  assert.equal(previous.index,4);
  const start=insertionAt({x:201,y:110},null,nodes,{layout:'snake',previous});
  assert.equal(start.index,1);
  assert.equal(start.side,'after');
  const end=insertionAt({x:270,y:380},null,nodes,{layout:'snake',previous:start});
  assert.equal(end.index,4);
  assert.equal(end.side,'before');
});

test('both halves of the source remain a no-op after visiting other targets',()=>{
  const nodes=[node('start',200,100),node('a',380,100),node('b',380,200),node('c',200,200),node('end',200,300)];
  for(const sourceId of ['a','b','c']){
    const from=nodes.findIndex(item=>item.id===sourceId),source=nodes[from];
    const previous=insertionAt({x:270,y:320},null,nodes,{layout:'snake',sourceId});
    for(const x of [source.rect.left+1,source.rect.right-1]){
      const result=insertionAt({x,y:source.rect.top+25},null,nodes,{layout:'snake',sourceId,previous});
      assert.equal(result.targetId,sourceId);
      assert.equal(movedInsertionIndex(from,result.index,nodes.length),from);
    }
  }
});

test('insertion indices account for removal and keep start/end fixed',()=>{
  assert.equal(movedInsertionIndex(1,3,5),2,'move a step after its next neighbor');
  assert.equal(movedInsertionIndex(3,1,5),1,'move a step before an earlier neighbor');
  assert.equal(movedInsertionIndex(2,0,5),1,'start terminal remains first');
  assert.equal(movedInsertionIndex(1,5,5),3,'end terminal remains last');
});
