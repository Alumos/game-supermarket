import test from 'node:test';
import assert from 'node:assert/strict';
import {TASKS,CHAPTERS,STOCK_MAP,DELIVERY_MAP,DELIVERY_RULES_VERSION,deliveryRulesVersion,deliveryRoadDelay,initialState,availableActions,validateGraph,simulate,exampleGraph,buildGraph,pathBetween,deliveryPathBetween,actionLabel,normalizeDeliveryGraph,normalizeDeliveryResult} from '../shared/engine.mjs';

const graph=(actions,chapterId=4,taskId='delivery')=>buildGraph(actions,{chapterId,taskId});
const move=(from,to)=>({actionId:'move_crate',params:{from,to}});
const to=point=>({actionId:'move_to',params:typeof point === 'string' ? {...DELIVERY_MAP.points[point]} : point});
const permutations=values=>values.length ? values.flatMap((v,i)=>permutations(values.filter((_,j)=>i!==j)).map(rest=>[v,...rest])) : [[]];

test('catalog exposes juice, four practice jobs and delivery with independent frozen definitions',()=>{
  assert.equal(CHAPTERS.length,4);assert.equal(TASKS.length,7);
  assert.deepEqual(TASKS.filter(t=>t.chapterId===3).map(t=>t.id),['rice-roll','tea','plant','fish']);
  assert.equal(initialState(2).taskId,'fresh-juice');assert.equal(initialState(3).taskId,'tea');assert.equal(initialState(4).taskId,'delivery');
  assert.equal(initialState(2,'rice-roll'),null);assert.equal(initialState(4,'stocking'),null);
  assert.deepEqual(availableActions(9),[]);
  for(const task of TASKS) {assert.equal(initialState(task.chapterId,task.id).taskId,task.id);assert.ok(availableActions(task.chapterId,task.id).length);}
  const a=initialState(4),b=initialState(4);a.orders[0].status='spoiled';a.position.x=99;
  assert.equal(b.orders[0].status,'pending');assert.deepEqual(b.position,DELIVERY_MAP.points.W);
  const actions=availableActions(4);actions[0].params.x=99;assert.equal(availableActions(4)[0].params.x,10);
  assert.ok(Object.isFrozen(DELIVERY_MAP.orders[0]));assert.ok(Object.isFrozen(STOCK_MAP.items.a));
});

test('both symmetric drink solutions and longer legal solutions satisfy the goal',()=>{
  for(const variant of ['best','alternate']) {
    const result=simulate(exampleGraph(1,'drink-swap',variant));
    assert.equal(result.completed,true);assert.deepEqual(result.finalState.slots,{A:'milk',B:'orange',C:null});assert.equal(result.finalState.holding,null);
    assert.equal(result.trace.filter(t=>t.actionId==='move_crate').length,3);
    assert.ok(result.trace.some(t=>t.events.some(e=>e.type==='take' && e.state.holding)));
  }
  assert.equal(simulate(graph([move('A','C'),move('C','A'),move('A','C'),move('B','A'),move('C','B')],1,'drink-swap')).completed,true);
  for(const action of [move('A','B'),move('C','A')]) {
    const result=simulate(graph([action],1,'drink-swap'));
    assert.equal(result.ok,false);assert.equal(result.errorNodeId,'step-1');assert.deepEqual(result.initialState,result.finalState);assert.equal(result.trace.length,1);
  }
});

test('juice, rice and tea require every production step in its meaningful order',()=>{
  for(const [chapterId,taskId] of [[2,'fresh-juice'],[3,'rice-roll'],[3,'tea']]) {
    assert.equal(simulate(exampleGraph(chapterId,taskId)).completed,true);
    const actions=availableActions(chapterId,taskId).map(a=>a.actionId);
    for(const order of permutations(actions)) assert.equal(simulate(graph(order,chapterId,taskId)).completed,JSON.stringify(order)===JSON.stringify(actions),`${taskId}: ${order}`);
    const duplicate=simulate(graph([actions[0],actions[0]],chapterId,taskId));
    assert.equal(duplicate.errorNodeId,'step-2');assert.deepEqual(duplicate.finalState,duplicate.trace.at(-1).after);
    assert.equal(simulate(graph(actions.slice(0,-1),chapterId,taskId)).completed,false);
  }
  const emptyJuicer=simulate(graph(['wash_orange','peel_cut','start_juicer'],2,'fresh-juice'));
  assert.equal(emptyJuicer.errorNodeId,'step-3');assert.match(emptyJuicer.message,/放入橙肉/);assert.equal(emptyJuicer.finalState.flags.start_juicer,undefined);
});

test('plant and fish accept the valid interchangeable orders',()=>{
  for(const [taskId,count] of [['plant',2],['fish',4]]) {
    const actions=availableActions(3,taskId).map(a=>a.actionId);
    assert.equal(permutations(actions).filter(order=>simulate(graph(order,3,taskId)).completed).length,count);
    assert.equal(simulate(exampleGraph(3,taskId,'alternate')).completed,true);
    assert.equal(simulate(graph(actions.slice(0,-1),3,taskId)).errors[0].code,'GOAL');
  }
});

test('delivery roads expose multiple connected routes with adjacent integer cells',()=>{
  assert.equal(DELIVERY_MAP.orders.length,6);assert.equal(DELIVERY_MAP.orders.filter(o=>o.cold).length,2);
  assert.ok(DELIVERY_MAP.links.length>=new Set(Object.values(DELIVERY_MAP.points).map(point=>`${point.x},${point.y}`)).size); // at least one road loop
  for(const a of Object.keys(DELIVERY_MAP.points)) for(const b of Object.keys(DELIVERY_MAP.points)) {
    const path=deliveryPathBetween(a,b);assert.ok(path.length);assert.deepEqual(path[0],DELIVERY_MAP.points[a]);assert.deepEqual(path.at(-1),DELIVERY_MAP.points[b]);
    for(let i=1;i<path.length;i++) assert.equal(Math.abs(path[i].x-path[i-1].x)+Math.abs(path[i].y-path[i-1].y),1);
  }
  for(const point of [null,{},'missing',{x:5,y:5},{x:10.5,y:7}]) assert.deepEqual(deliveryPathBetween(point,'A'),[]);
  assert.deepEqual(deliveryPathBetween('W','W'),[{x:10,y:1}]);
  assert.equal(pathBetween('B','D').length-1,16); // legacy map remains readable for old records
});

test('lower road G H I aliases support the same legal paths and executable moves',()=>{
  for(const [alias,internal] of [['G','J1'],['H','J0'],['I','J2']])assert.deepEqual(DELIVERY_MAP.points[alias],DELIVERY_MAP.points[internal]);
  assert.deepEqual(deliveryPathBetween('G','I'),deliveryPathBetween({x:4,y:3},{x:16,y:3}));
  assert.equal(deliveryPathBetween('G','I').length-1,12);
  const program=graph([to('H'),to('G')]);
  assert.equal(validateGraph(program).ok,true);
  const result=simulate(program);
  assert.equal(result.errors[0].code,'GOAL'); // two legal moves, remaining six orders
  assert.deepEqual(result.trace.filter(row=>row.actionId==='move_to').map(row=>row.after.position),[{x:10,y:3},{x:4,y:3}]);
  assert.equal(result.metrics.walk,8);assert.equal(result.metrics.handling,0);
  assert.deepEqual(result.finalState.position,DELIVERY_MAP.points.G);
});

test('delivery coordinates increase northward without changing other scenes or route geometry',()=>{
  assert.equal(DELIVERY_MAP.coordinateMaxY,14);assert.equal(DELIVERY_MAP.coordinateSystem,'cartesian-y-up');
  assert.deepEqual(DELIVERY_MAP.points,{W:{x:10,y:1},J0:{x:10,y:3},J1:{x:4,y:3},J2:{x:16,y:3},A:{x:4,y:7},B:{x:10,y:7},C:{x:16,y:7},D:{x:4,y:11},E:{x:10,y:11},F:{x:16,y:11},G:{x:4,y:3},H:{x:10,y:3},I:{x:16,y:3}});
  assert.deepEqual(availableActions(4)[0].params,{x:10,y:3});
  assert.deepEqual(initialState(4).position,{x:10,y:1});
  assert.equal(initialState(4).timeUnit,'minutes');assert.equal(DELIVERY_MAP.timeUnit,'minutes');
  assert.equal(DELIVERY_MAP.minutesPerCell,1);assert.equal(DELIVERY_MAP.handlingMinutes,2);assert.equal(DELIVERY_MAP.bonusEveryMinutes,4);
  for(const chapter of [1,2,3])assert.equal(initialState(chapter).timeUnit,undefined);
  assert.deepEqual(initialState(1).position,{x:10,y:13});
  assert.deepEqual(initialState(2).position,{x:10,y:13});
  assert.deepEqual(initialState(3).position,{x:10,y:13});
  const north=deliveryPathBetween('W','E');
  assert.ok(north.every((point,index)=>index===0 || point.y>=north[index-1].y));
  assert.equal(north.length-1,10);
  const example=exampleGraph(4);
  assert.equal(example.deliveryCoordinates,'cartesian-y-up');assert.equal(example.contentVersion,'1.0.0');
  assert.equal(buildGraph([],{chapterId:4,taskId:'delivery'}).deliveryCoordinates,'cartesian-y-up');
  assert.equal(exampleGraph(2).deliveryCoordinates,undefined);
  assert.deepEqual(example.nodes.filter(node=>node.kind==='action').map(node=>node.params),['H','B','E','D','A','B','C','F'].map(point=>DELIVERY_MAP.points[point]));
  assert.equal(normalizeDeliveryGraph(example),example);
  assert.equal(normalizeDeliveryGraph(exampleGraph(2)).taskId,'fresh-juice');
});

test('legacy delivery graphs normalize once and keep the exact route, metrics and source input',()=>{
  for (const variant of ['best','bad']) {
    const modern=exampleGraph(4,'delivery',variant),legacy=structuredClone(modern);
    delete legacy.deliveryCoordinates;
    for (const node of legacy.nodes) if (node.actionId === 'move_to') node.params.y=14-node.params.y;
    const untouched=structuredClone(legacy),normalized=normalizeDeliveryGraph(legacy);
    assert.notEqual(normalized,legacy);assert.deepEqual(normalized,modern);assert.deepEqual(legacy,untouched);
    assert.equal(normalizeDeliveryGraph(normalized),normalized);
    assert.deepEqual(validateGraph(legacy),validateGraph(modern));
    assert.deepEqual(simulate(legacy),simulate(modern));assert.deepEqual(legacy,untouched);
    assert.equal(simulate(legacy).finalState.deliveryCoordinates,'cartesian-y-up');
  }
  for (const value of [null,undefined,{},[],exampleGraph(1),exampleGraph(2)]) assert.equal(normalizeDeliveryGraph(value),value);
  const malformed={taskId:'delivery',nodes:[null,{actionId:'move_to',params:null},{actionId:'move_to',params:{x:10,y:'bad'}}]};
  assert.doesNotThrow(()=>normalizeDeliveryGraph(malformed));
  assert.equal(normalizeDeliveryGraph(malformed).nodes[2].params.y,'bad');
});

test('legacy delivery result conversion preserves immutable history and all nested event geometry',()=>{
  const modernGraph=exampleGraph(4),legacyGraph=structuredClone(modernGraph);delete legacyGraph.deliveryCoordinates;
  for (const node of legacyGraph.nodes) if (node.actionId === 'move_to') node.params.y=14-node.params.y;
  const modernResult=simulate(modernGraph),legacyResult=structuredClone(modernResult);
  const oldCoordinates=value=>{
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {value.forEach(oldCoordinates);return;}
    delete value.deliveryCoordinates;delete value.timeUnit;
    for (const [field,item] of Object.entries(value)) {
      if (['position','from','to'].includes(field) && item && Number.isFinite(item.y)) item.y=14-item.y;
      else if (field === 'path' && Array.isArray(item)) for (const point of item) point.y=14-point.y;
      else if (field === 'params' && value.actionId === 'move_to') item.y=14-item.y;
      else oldCoordinates(item);
    }
  };
  oldCoordinates(legacyResult);
  const original=structuredClone(legacyResult),converted=normalizeDeliveryResult(legacyResult,legacyGraph);
  assert.notEqual(converted,legacyResult);assert.deepEqual(legacyResult,original);
  const expected={...modernResult,deliveryCoordinates:'cartesian-y-up'};
  assert.deepEqual(converted,expected);assert.deepEqual(converted.metrics,legacyResult.metrics);
  assert.equal(normalizeDeliveryResult(converted,legacyGraph),converted);
  assert.deepEqual(normalizeDeliveryResult(legacyResult),expected);
  const traceOnly={trace:legacyResult.trace},traceCopy=structuredClone(traceOnly);
  assert.deepEqual(normalizeDeliveryResult(traceOnly,legacyGraph).trace,modernResult.trace);assert.deepEqual(traceOnly,traceCopy);
  assert.equal(normalizeDeliveryResult(modernResult,modernGraph),modernResult);
  assert.equal(normalizeDeliveryResult(modernResult,legacyGraph),modernResult); // server replay of an old graph already has new event coordinates
  for (const value of [null,undefined,{},[]]) assert.equal(normalizeDeliveryResult(value,modernGraph),value);
  assert.equal(normalizeDeliveryResult(simulate(exampleGraph(2)),exampleGraph(2)).finalState.taskId,'fresh-juice');
});

test('minute task units preserve route values and upgrade historical display copies without rescaling',()=>{
  const graph=exampleGraph(4),result=simulate(graph);
  assert.equal(result.timeUnit,'minutes');assert.equal(result.initialState.timeUnit,'minutes');assert.equal(result.finalState.timeUnit,'minutes');
  assert.equal(result.metrics.total,50);assert.equal(result.metrics.coins,115);
  for(const row of result.trace) {
    assert.equal(row.before.timeUnit,'minutes');assert.equal(row.after.timeUnit,'minutes');
    for(const event of row.events)assert.equal(event.state.timeUnit,'minutes');
  }
  const previous=structuredClone(result);
  const removeUnit=value=>{if(value&&typeof value==='object'){delete value.timeUnit;for(const child of Object.values(value))removeUnit(child);}};
  removeUnit(previous);const original=structuredClone(previous),display=normalizeDeliveryResult(previous,graph);
  assert.deepEqual(display,result);assert.deepEqual(previous,original);assert.notEqual(display,previous);
  assert.equal(display.metrics.total,50);assert.equal(display.finalState.orders.find(order=>order.point==='A').deadline,28);
  assert.equal(display.finalState.orders.find(order=>order.point==='D').deadline,56);
  assert.equal(normalizeDeliveryResult(display,graph),display);
  assert.equal(simulate(exampleGraph(2)).timeUnit,undefined);
});

test('roadside delays keep several successful plans and reward thoughtful route order',()=>{
  for(const [variant,coins,delivered,failed,total] of [['best',115,6,0,50],['good',107,6,0,51],['demo',107,6,0,51],['bad',83,5,1,49],['cross',83,5,1,49]]) {
    const source=exampleGraph(4,'delivery',variant),copy=structuredClone(source),result=simulate(source);
    assert.equal(result.ok,true);assert.equal(result.completed,true);
    assert.deepEqual(result.metrics,{walk:total-12,handling:12,total,onTime:failed===0,coins,delivered,failed});
    assert.equal(result.finalState.elapsed,total);assert.equal(result.finalState.coins,coins);assert.equal(result.trace.at(-1).cumulative,total);
    assert.ok(result.finalState.orders.every(o=>o.status!=='pending' && Number.isInteger(o.arrivedAt)));
    assert.deepEqual(source,copy);assert.deepEqual(simulate(source),result); // wall clock and replay speed have no role
  }
  assert.deepEqual(simulate(exampleGraph(4,'bad')).finalState.orders.filter(o=>o.status==='spoiled').map(o=>o.point),['A']);
});

test('exhaustive six-address bounds prove maximum coins and the fastest route attaining that reward',()=>{
  // Every actual first-visit order is a permutation. Shortest pairwise distances
  // give optimistic arrival times even when that direct path crosses another order.
  // This supplies a global reward upper bound and time lower bound for all routes.
  // Independent Dijkstra reference: a short road can be slower than a detour.
  const cells=new Map(),key=p=>`${p.x},${p.y}`,distances=new Map();
  for(const [from,to] of DELIVERY_MAP.links){
    const a=DELIVERY_MAP.points[from],b=DELIVERY_MAP.points[to],n=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
    for(let i=0;i<=n;i++){const p={x:a.x+Math.sign(b.x-a.x)*i,y:a.y+Math.sign(b.y-a.y)*i};cells.set(key(p),p);}
  }
  for(const from of ['W',...DELIVERY_MAP.orders.map(o=>o.point)]){
    const remaining=new Set(cells.keys()),costs=new Map([[key(DELIVERY_MAP.points[from]),0]]);
    while(remaining.size){
      const current=[...remaining].reduce((a,b)=>(costs.get(a)??Infinity)<=(costs.get(b)??Infinity)?a:b),p=cells.get(current);
      remaining.delete(current);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const q={x:p.x+dx,y:p.y+dy},id=key(q);if(!remaining.has(id))continue;
        const road=DELIVERY_MAP.slowRoads.find(r=>(key(r.from)===current&&key(r.to)===id)||(key(r.to)===current&&key(r.from)===id));
        const cost=costs.get(current)+DELIVERY_MAP.minutesPerCell+(road?.minutes||0);
        if(cost<(costs.get(id)??Infinity))costs.set(id,cost);
      }
    }
    for(const target of DELIVERY_MAP.orders)distances.set(from+target.point,costs.get(key(DELIVERY_MAP.points[target.point])));
  }
  let upperCoins=-Infinity,lowerTime=Infinity,bestRewardTime=Infinity;
  for(const order of permutations(DELIVERY_MAP.orders)) {
    let point='W',elapsed=0,coins=0;
    for(const item of order) {
      elapsed+=distances.get(point+item.point);
      coins+=elapsed<=item.deadline ? item.baseReward+Math.floor((item.deadline-elapsed)/DELIVERY_MAP.bonusEveryMinutes) : -item.penalty;
      elapsed+=DELIVERY_MAP.handlingMinutes;point=item.point;
    }
    if(coins>upperCoins){upperCoins=coins;bestRewardTime=elapsed;}else if(coins===upperCoins)bestRewardTime=Math.min(bestRewardTime,elapsed);
    lowerTime=Math.min(lowerTime,elapsed);
  }
  const best=simulate(exampleGraph(4));assert.equal(best.metrics.coins,upperCoins);assert.equal(upperCoins,115);assert.equal(best.metrics.total,bestRewardTime);assert.equal(lowerTime,45);assert.equal(best.metrics.failed,0);
});

test('passing an address automatically delivers once, with walk and delivery snapshots in order',()=>{
  const result=simulate({...graph([to('E'),to('B'),to('E')]),deliveryRulesVersion:'split-cold-v2'});
  assert.equal(result.errors[0].code,'GOAL');
  const first=result.trace.find(row=>row.actionId==='move_to');
  assert.deepEqual(first.events.map(e=>e.type),['walk','delivery','walk','delivery']);
  assert.deepEqual(first.events.map(e=>e.duration),[6,2,4,2]);
  assert.equal(first.events[0].state.elapsed,6);assert.equal(first.events[0].state.orders.find(o=>o.point==='B').status,'pending');
  assert.equal(first.events[1].arrivedAt,6);assert.equal(first.events[1].state.elapsed,8);assert.equal(first.events[1].state.orders.find(o=>o.point==='B').status,'delivered');
  assert.equal(first.events[2].state.elapsed,12);assert.equal(first.events[3].arrivedAt,12);
  assert.equal(result.trace.flatMap(row=>row.events).filter(e=>e.type==='delivery').length,2);
  assert.equal(result.metrics.handling,4);assert.equal(result.metrics.total,22);
  first.events[1].state.orders[0].status='spoiled';assert.equal(first.events[2].state.orders[0].status,'pending');
});

test('one coordinate block cannot turn, cross a building, or teleport; rejection is atomic',()=>{
  const cases=[
    [to('A')], // both x and y differ, although the exploration path exists
    [to('B'),to('A'),to({x:4,y:9}),to({x:16,y:9})] // endpoints on roads, middle through buildings
  ];
  for(const actions of cases) {
    const result=simulate(graph(actions));assert.equal(result.ok,false);assert.equal(result.errors[0].code,'ROAD');assert.match(result.message,/拐点/);
    assert.equal(result.errorNodeId,`step-${actions.length}`);assert.deepEqual(result.finalState,result.trace.at(-1).after);assert.equal(result.metrics.total,result.trace.at(-1).cumulative);
  }
  assert.equal(simulate(graph([to('W'),to('B'),to('A'),to('D'),to('E'),to('F'),to('C')])).completed,true);
});

test('deadline is inclusive, handling time counts, and expiry is resolved on arrival',()=>{
  const exact=simulate(graph([to('B'),to('W'),to('B'),to({x:9,y:7}),to('B'),to('A')]));
  const a=exact.finalState.orders.find(o=>o.point==='A');
  assert.equal(a.arrivedAt,28);assert.equal(a.status,'delivered');
  assert.equal(exact.trace.flatMap(r=>r.events).find(e=>e.orderId==='order-a').coins,18);
  const late=simulate(graph([to('B'),to('W'),to('B'),to({x:8,y:7}),to('B'),to('A')]));
  const spoiled=late.finalState.orders.find(o=>o.point==='A');
  assert.equal(spoiled.arrivedAt,30);assert.equal(spoiled.status,'spoiled');
  assert.equal(late.finalState.orders.find(o=>o.point==='E').status,'pending'); // expired but not yet attempted
  const event=late.trace.flatMap(r=>r.events).find(e=>e.orderId==='order-a');assert.equal(event.coins,-18);assert.equal(event.duration,2);
  assert.equal(late.metrics.handling,4);assert.equal(late.metrics.failed,1);
});

test('short perimeter is insufficient and old saved rules replay without being rewritten',()=>{
  const current=graph(['H','B','A','D','E','F','C'].map(to)),untouched=structuredClone(current);
  const result=simulate(current);assert.deepEqual(result.metrics,{walk:33,handling:12,total:45,onTime:false,coins:82,delivered:5,failed:1});
  assert.equal(result.finalState.orders.find(o=>o.point==='E').status,'spoiled');
  assert.deepEqual(result.finalState.orders.filter(o=>o.cold).map(o=>o.point),['A','E']);
  assert.equal(result.finalState.orders.find(o=>o.point==='D').name,'饼干订单');
  assert.equal(deliveryRulesVersion(current),DELIVERY_RULES_VERSION);assert.equal(deliveryRulesVersion(result),DELIVERY_RULES_VERSION);
  const legacy=structuredClone(current);delete legacy.deliveryRulesVersion;
  const before=structuredClone(legacy),old=simulate(legacy);
  assert.deepEqual(old.metrics,{walk:32,handling:12,total:44,onTime:true,coins:115,delivered:6,failed:0});
  assert.deepEqual(old.finalState.orders.filter(o=>o.cold).map(o=>o.point),['A','D']);
  assert.equal(deliveryRulesVersion(legacy),'left-cold-v1');assert.equal(deliveryRulesVersion(old),'left-cold-v1');
  assert.deepEqual(legacy,before);assert.deepEqual(current,untouched);
  const oldTrace=structuredClone(old.trace);const stripRules=value=>{if(value&&typeof value==='object'){delete value.deliveryRulesVersion;for(const child of Object.values(value))stripRules(child);}};stripRules(oldTrace);
  const traceOriginal=structuredClone(oldTrace);assert.deepEqual(normalizeDeliveryResult({trace:oldTrace},legacy).trace,old.trace);assert.deepEqual(oldTrace,traceOriginal);
  const badVersion={...current,deliveryRulesVersion:'future-rules'};assert.equal(validateGraph(badVersion).ok,false);
});

test('every completed delivery trace snapshot and metric conserves simulated time and coins',()=>{
  const result=simulate(exampleGraph(4));let elapsed=0,coins=0,walk=0,handling=0;
  for(const row of result.trace) {
    assert.equal(row.duration,row.events.reduce((sum,event)=>sum+event.duration,0));
    for(const event of row.events) {
      elapsed+=event.duration;assert.equal(event.state.elapsed,elapsed);
      if(event.type==='walk') {walk+=event.duration;assert.equal((event.path.length-1)*DELIVERY_MAP.minutesPerCell+(event.roadDelay?.minutes||0),event.duration);}
      if(event.type==='delivery') {handling+=event.duration;coins+=event.coins;}
      assert.equal(event.state.coins,coins);
    }
    assert.equal(row.cumulative,elapsed);assert.deepEqual(row.after,row.events.at(-1)?.state ?? row.before);
  }
  assert.equal(walk,result.metrics.walk);assert.equal(handling,result.metrics.handling);assert.equal(elapsed,result.metrics.total);assert.equal(coins,result.metrics.coins);
});

test('slow roads charge once per crossing in either direction and cannot be avoided by splitting blocks',()=>{
  assert.equal(DELIVERY_MAP.slowRoads.length,4);
  for(const road of DELIVERY_MAP.slowRoads){
    assert.ok([1,2].includes(road.minutes));
    assert.equal(deliveryPathBetween(road.from,road.to).length,2,'marked road is one legal adjacent edge');
    const forward=simulate(graph([to('H'),to('G'),to('A')]));
    if(road.id==='school')assert.ok(forward.trace.flatMap(t=>t.events).some(e=>e.roadDelay?.id==='school'));
    assert.equal(deliveryRoadDelay(road.from,road.to),road);
    assert.equal(deliveryRoadDelay(road.to,road.from),road);
    assert.equal(deliveryRoadDelay(road.from,road.to,'split-cold-v2'),null);
  }
  const whole=simulate(graph([to('E'),to('B'),to('E')]));
  const split=simulate(graph([to('B'),to({x:10,y:8}),to({x:10,y:9}),to('E'),to('B'),to('E')]));
  assert.deepEqual(whole.metrics,split.metrics);assert.deepEqual(whole.finalState,split.finalState);
  const penalties=whole.trace.flatMap(t=>t.events).filter(e=>e.roadDelay);
  assert.equal(penalties.length,3);assert.ok(penalties.every(e=>e.roadDelay.id==='signal'&&e.duration===2&&e.path.length===2));
  const stationary=simulate(graph([to('B'),to({x:10,y:8}),to({x:10,y:8})]));
  assert.equal(stationary.trace.at(-2).duration,0,'remaining at a marked point does not add waiting');
});

test('split-cold-v2 history retains its original deadlines, times and rewards without roadside costs',()=>{
  for(const [variant,coins,failed] of [['best',117,0],['demo',110,0],['bad',84,1]]){
    const source={...exampleGraph(4,'delivery',variant),deliveryRulesVersion:'split-cold-v2'},before=structuredClone(source),result=simulate(source);
    assert.equal(result.completed,true);assert.deepEqual(source,before);
    assert.deepEqual(result.metrics,{walk:36,handling:12,total:48,onTime:failed===0,coins,delivered:6-failed,failed});
    assert.ok(result.finalState.orders.filter(o=>o.cold).every(o=>o.deadline===26));
    assert.equal(result.trace.flatMap(t=>t.events).filter(e=>e.roadDelay).length,0);
  }
});

test('graph validation rejects structural faults before executing actions',()=>{
  const mutations=[g=>{g.nodes[1].id=g.nodes[0].id;},g=>{g.nodes.push({id:'start2',kind:'start'});},g=>{g.nodes.push({id:'end2',kind:'end'});},g=>{g.edges.pop();},g=>{g.edges.push({from:'start',to:'end'});},g=>{g.edges.push({from:'missing',to:'end'});},g=>{g.edges.push({...g.edges[0]});},g=>{g.nodes.push({id:'isolated',kind:'action',actionId:'wash_orange'});},g=>{g.edges.push({from:'end',to:'start'});},g=>{g.nodes[1].actionId='unknown';},g=>{g.nodes[1].kind='branch';},g=>{g.schemaVersion=2;},g=>{g.contentVersion='0.1';},g=>{g.revision=-1;},g=>{g.taskId='tea';},g=>{g.nodes[1].label=123;},g=>{delete g.taskId;}];
  for(const mutate of mutations) {const g=exampleGraph(2);mutate(g);assert.equal(validateGraph(g).ok,false);const result=simulate(g);assert.equal(result.trace.length,0);assert.deepEqual(result.initialState,result.finalState);}
  const disconnected=graph(['wash_orange'],2,'fresh-juice');disconnected.nodes.push({id:'loop',kind:'action',actionId:'peel_cut'});disconnected.edges.push({from:'loop',to:'loop'});
  assert.ok(validateGraph(disconnected).errors.some(e=>e.code==='CYCLE'));
  assert.equal(validateGraph(graph(Array(22).fill('wash_orange'),2,'fresh-juice')).ok,true);
  assert.equal(validateGraph(graph(Array(23).fill('wash_orange'),2,'fresh-juice')).ok,false);
  assert.equal(validateGraph(graph(Array.from({length:46},()=>to('W')))).ok,true);
  assert.equal(validateGraph(graph(Array.from({length:47},()=>to('W')))).ok,false);
});

test('malformed graphs, parameters, and task mismatches return useful errors without throwing',()=>{
  for(const g of [null,undefined,{},[],{nodes:null,edges:[]},graph([{actionId:'move_to'}]),graph([to(null)]),graph([to({x:5,y:5})]),graph([to({x:10.5,y:7})]),graph([to({x:'10',y:7})]),graph([to({x:Infinity,y:7})]),graph([move('A','A')],1,'drink-swap')]) {
    let result;assert.doesNotThrow(()=>{result=simulate(g);});assert.equal(result.ok,false);assert.ok(result.errors.length);
  }
  assert.equal(simulate(exampleGraph(1),{chapterId:4,taskId:'delivery'}).ok,false);
  assert.equal(simulate(exampleGraph(4),null).completed,true);
});

test('trace follows edges, retains custom labels and labels coordinates for the block UI',()=>{
  const g=exampleGraph(2);g.nodes[1].label='我的清洗步骤';const expected=g.nodes.map(n=>n.id);g.nodes.reverse();
  const result=simulate(g);assert.equal(result.completed,true);assert.deepEqual(result.trace.map(t=>t.nodeId),expected);assert.equal(result.trace[1].label,'我的清洗步骤');
  for(const id of ['W','A','B','C','D','E','F','G','H','I']){
    const {x,y}=DELIVERY_MAP.points[id];assert.equal(actionLabel(to(id)),`移动到 ${id}（${x}，${y}）`);
  }
  assert.equal(actionLabel(to('J0')),'移动到 H（10，3）');
  assert.equal(actionLabel(to({x:10,y:5})),'移动到（10，5）');
  assert.equal(actionLabel(null),'未选择操作');assert.equal(actionLabel('start_juicer'),'启动机器榨汁');
});
