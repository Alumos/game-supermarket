// Deterministic classroom rules. This module has no browser or server dependencies.
const clone = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export const LEARNING_GOALS = freeze({
  1:'了解顺序结构的特点',
  2:'学会将操作步骤转换成流程图',
  3:'学会用算法思维解决问题',
  4:'了解算法优化'
});
export const CHAPTERS = freeze([
  {id:1,title:'饮料区换柜',subtitle:'先腾出一个位置',story:'饮料柜员请你把橙汁与牛奶交换位置。周转位C是空的，一次只能搬一箱。',outro:'位置换好了！如果饮料种类更多，怎样安排能少搬几次呢？'},
  {id:2,title:'水果区鲜榨橙汁',subtitle:'让每一步准备好下一步',story:'水果区师傅请你制作一杯鲜榨橙汁。先处理橙子，放入橙肉，再启动榨汁机。',outro:'橙汁做好了！清楚的顺序能让机器正确工作。接下来，去其他岗位试试吧。'},
  {id:3,title:'综合实践区',subtitle:'选一个任务，跟着师傅学',story:'饭卷、茶饮、绿植、观赏鱼，选一个任务试试。写清步骤，也可以换个区继续学习，作品会分别保存。',outro:'各岗位准备好了，配送站还有六份订单。一起规划路线，按时送到顾客手中！'},
  {id:4,title:'社区配送',subtitle:'规划路线，按时送达',story:'配送站有六份订单，其中两份需要冷藏。用移动到坐标积木沿道路送单，比较路程、时效和金币。思考与暂停不计时。',outro:'比较两轮配送，解释路线顺序怎样影响订单时效与收益。'}
]);
const cards = pairs => pairs.map(([actionId,label,params]) => ({actionId,label,...(params ? {params} : {})}));
export const TASKS = freeze([
  {id:'drink-swap',chapterId:1,name:'饮料换柜',npc:'饮料柜员',description:'A柜的橙汁与B柜的牛奶要交换位置，C是空闲周转位。',goal:'A放牛奶，B放橙汁，C空着，双手空闲。',actions:cards([['move_crate','搬运饮料箱',{from:'A',to:'C'}]])},
  {id:'fresh-juice',chapterId:2,name:'鲜榨橙汁',npc:'水果区师傅',description:'清洗、去皮切块后先放入橙肉，再启动机器，避免空转。',goal:'依次完成五步，打包鲜榨橙汁。',actions:cards([['wash_orange','清洗橙子'],['peel_cut','去皮切块'],['add_orange','放入橙肉'],['start_juicer','启动机器榨汁'],['pack_juice','打包饮品']])},
  {id:'rice-roll',chapterId:3,name:'制作海苔饭卷',npc:'熟食师傅',description:'按材料和工序要求制作海苔饭卷。',goal:'完成五项操作，切段装盒。',actions:cards([['seaweed','铺开海苔'],['rice','铺匀熟米饭'],['filling','放上熟制馅料'],['roll','卷紧定形'],['pack','切段装盒']])},
  {id:'tea',chapterId:3,name:'茶饮岗位',npc:'茶饮师傅',description:'用规定量的适温水制作一杯茶饮，浸泡后取出茶包。',goal:'完成茶饮，加盖贴签。',actions:cards([['cup','取杯放茶包'],['water','注入规定量适温水'],['steep','等待浸泡（快进）'],['remove_bag','取出茶包'],['lid','加盖贴签']])},
  {id:'plant',chapterId:3,name:'植物岗位',npc:'园艺师傅',description:'给植株上盆；填土后，浇水和放品名牌的先后可以交换。',goal:'栽好植株、按量浇水并放好品名牌。',actions:cards([['soil','盆底铺土'],['plant','放入带土根团'],['fill','填土轻压'],['water_plant','按规定量浇水'],['label_plant','放品名牌']])},
  {id:'fish',chapterId:3,name:'观赏鱼岗位',npc:'养护师傅',description:'领取一次用量鱼粮并打开投喂口后，才可以投喂；投喂后合盖和记录可交换。',goal:'完成一次投喂，关闭投喂口并做好记录。',actions:cards([['fishfood','领取一次用量鱼粮'],['open_feed','打开投喂口'],['feed','定点投喂'],['close_feed','合上投喂口'],['record_feed','记录投喂']])},
  {id:'delivery',chapterId:4,name:'社区配送',npc:'配送站师傅',description:'沿道路配送六份订单，冷藏订单应优先送达；每格1分钟，每单交付2分钟。留意路旁标记，慢行路段额外增加1～2分钟。',goal:'处理六份订单，比较按时单数与金币收益。',actions:cards([['move_to','移动到坐标',{x:10,y:3}]])}
]);
export const STOCK_MAP = freeze({
  points:{W:{x:10,y:13},J:{x:10,y:11},A:{x:6,y:11},B:{x:6,y:7},C:{x:14,y:11},D:{x:14,y:7}},
  links:[['W','J'],['J','A'],['A','B'],['J','C'],['C','D']],
  items:{a:{id:'a',name:'橙汁箱',shelf:'A'},b:{id:'b',name:'饼干箱',shelf:'B'},c:{id:'c',name:'纸巾箱',shelf:'C'},d:{id:'d',name:'文具箱',shelf:'D'}},
  capacity:2,targetSeconds:60
});
// Current classroom rule set. Historical runs explicitly marked roadside-v3,
// split-cold-v2, or left-cold-v1 continue to use their original orders and
// deadlines below; changing the current version must never rewrite history.
export const DELIVERY_RULES_VERSION='roadside-v4';
export const DELIVERY_RULES_V3='roadside-v3';
const SPLIT_DELIVERY_RULES_VERSION='split-cold-v2';
const LEGACY_DELIVERY_RULES_VERSION='left-cold-v1';
export const deliveryRulesVersion=value=>value?.deliveryRulesVersion??value?.graph?.deliveryRulesVersion??value?.result?.deliveryRulesVersion??LEGACY_DELIVERY_RULES_VERSION;
export const DELIVERY_MAP = freeze({
  width:21,height:16,coordinateMaxY:14,coordinateSystem:'cartesian-y-up',
  // Delivery uses mathematical coordinates: larger y means farther north.
  // Renderers convert logical y to screen-row (coordinateMaxY - y).
  points:{W:{x:10,y:1},J0:{x:10,y:3},J1:{x:4,y:3},J2:{x:16,y:3},A:{x:4,y:7},B:{x:10,y:7},C:{x:16,y:7},D:{x:4,y:11},E:{x:10,y:11},F:{x:16,y:11},G:{x:4,y:3},H:{x:10,y:3},I:{x:16,y:3}},
  links:[['W','J0'],['J1','J0'],['J0','J2'],['A','B'],['B','C'],['D','E'],['E','F'],['J1','A'],['A','D'],['J0','B'],['B','E'],['J2','C'],['C','F']],
  orders:[
    {id:'order-a',name:'鲜奶订单',point:'A',cold:true,deadline:30,baseReward:18,penalty:18},
    {id:'order-b',name:'文具订单',point:'B',cold:false,deadline:50,baseReward:12,penalty:12},
    {id:'order-c',name:'纸巾订单',point:'C',cold:false,deadline:66,baseReward:12,penalty:12},
    {id:'order-d',name:'饼干订单',point:'D',cold:false,deadline:56,baseReward:12,penalty:12},
    {id:'order-e',name:'酸奶订单',point:'E',cold:true,deadline:30,baseReward:18,penalty:18},
    {id:'order-f',name:'水果订单',point:'F',cold:false,deadline:62,baseReward:12,penalty:12}
  ],
  slowRoads:[
    {id:'hospital',name:'医院慢行',from:{x:6,y:11},to:{x:7,y:11},minutes:1},
    {id:'school',name:'学校慢行',from:{x:4,y:5},to:{x:4,y:6},minutes:1},
    {id:'station',name:'车站人流',from:{x:16,y:5},to:{x:16,y:6},minutes:2},
    {id:'signal',name:'红绿灯',from:{x:10,y:8},to:{x:10,y:9},minutes:1}
  ],
  timeUnit:'minutes',minutesPerCell:1,handlingMinutes:2,bonusEveryMinutes:4,
  // Legacy aliases retain the same task-time values; animation durations are unchanged.
  secondsPerCell:1,handlingSeconds:2,bonusEverySeconds:4
});
const roadsideV3Orders=freeze([
  {id:'order-a',name:'鲜奶订单',point:'A',cold:true,deadline:28,baseReward:18,penalty:18},
  {id:'order-b',name:'文具订单',point:'B',cold:false,deadline:50,baseReward:12,penalty:12},
  {id:'order-c',name:'纸巾订单',point:'C',cold:false,deadline:66,baseReward:12,penalty:12},
  {id:'order-d',name:'饼干订单',point:'D',cold:false,deadline:56,baseReward:12,penalty:12},
  {id:'order-e',name:'酸奶订单',point:'E',cold:true,deadline:28,baseReward:18,penalty:18},
  {id:'order-f',name:'水果订单',point:'F',cold:false,deadline:62,baseReward:12,penalty:12}
]);
// Unmarked saved programs retain their original order rules for authoritative replay.
const splitDeliveryOrders=freeze(DELIVERY_MAP.orders.map(order=>({...order,...(order.cold?{deadline:26}:{})})));
const legacyDeliveryOrders=freeze(splitDeliveryOrders.map(order=>({...order,...({A:{deadline:16},D:{name:'酸奶订单',cold:true,deadline:24,baseReward:18,penalty:18},E:{name:'饼干订单',cold:false,deadline:58,baseReward:12,penalty:12}}[order.point]||{})})));
export function deliveryRoadDelay(from,to,rulesVersion=DELIVERY_RULES_VERSION){
  if(rulesVersion!==DELIVERY_RULES_VERSION && rulesVersion!==DELIVERY_RULES_V3)return null;
  return DELIVERY_MAP.slowRoads.find(road=>(same(from,road.from)&&same(to,road.to))||(same(from,road.to)&&same(to,road.from)))||null;
}
const deliveryCoordinateSystem=DELIVERY_MAP.coordinateSystem;
const legacyDelivery=value=>value && typeof value === 'object' && !Array.isArray(value) && value.taskId === 'delivery' && value.deliveryCoordinates !== deliveryCoordinateSystem;
const flippedPoint=value=>value && typeof value === 'object' && !Array.isArray(value) && Number.isFinite(value.y) ? {...value,y:DELIVERY_MAP.coordinateMaxY-value.y} : value;
// Coordinate metadata is additive to contentVersion 1.0.0. Persisted unmarked
// delivery programs used screen-style y; normalization preserves their routes.
export function normalizeDeliveryGraph(graph) {
  if (!legacyDelivery(graph)) return graph;
  const normalized=clone(graph);
  normalized.deliveryCoordinates=deliveryCoordinateSystem;
  if (Array.isArray(normalized.nodes)) for (const node of normalized.nodes) {
    if (node?.actionId === 'move_to' && node.params && typeof node.params === 'object' && !Array.isArray(node.params)) node.params=flippedPoint(node.params);
  }
  return normalized;
}
// Historical results remain immutable. This returns a display copy in the new
// coordinates and also supports {trace: oldRun.trace} with the original graph.
export function normalizeDeliveryResult(result,graph) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.keys(result).length) return result;
  const source=graph ?? result.initialState ?? result.finalState;
  const delivery=source?.taskId === 'delivery' || result.initialState?.taskId === 'delivery' || result.finalState?.taskId === 'delivery' || result.deliveryCoordinates === deliveryCoordinateSystem;
  if (!delivery) return result;
  const flip=result.deliveryCoordinates !== deliveryCoordinateSystem && legacyDelivery(source);
  if (!flip && result.timeUnit === 'minutes' && result.deliveryRulesVersion) return result;
  const rulesVersion=result.deliveryRulesVersion??deliveryRulesVersion(source);
  const normalized=clone(result);
  const transform=value=>{
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {for (const item of value) transform(item);return;}
    if (value.taskId === 'delivery') {value.deliveryCoordinates=deliveryCoordinateSystem;value.timeUnit='minutes';value.deliveryRulesVersion??=rulesVersion;}
    for (const [field,item] of Object.entries(value)) {
      if (flip && ['position','from','to'].includes(field)) value[field]=flippedPoint(item);
      else if (flip && field === 'path' && Array.isArray(item)) value[field]=item.map(flippedPoint);
      else if (flip && field === 'params' && value.actionId === 'move_to') value[field]=flippedPoint(item);
      else transform(item);
    }
  };
  transform(normalized);
  normalized.deliveryCoordinates=deliveryCoordinateSystem;
  normalized.timeUnit='minutes';
  normalized.deliveryRulesVersion=rulesVersion;
  return normalized;
}

const DRINK_POINTS = {A:{x:5,y:9},B:{x:10,y:9},C:{x:15,y:9}};
const WORK_POINTS = {'fresh-juice':{x:10,y:9},'rice-roll':{x:3,y:9},tea:{x:8,y:9},plant:{x:13,y:9},fish:{x:18,y:9}};
const DEFAULT_TASK = {1:'drink-swap',2:'fresh-juice',3:'tea',4:'delivery'};
function taskFor(chapterId=1,taskId) {
  return TASKS.find(t => t.id === (taskId ?? DEFAULT_TASK[chapterId]) && t.chapterId === chapterId);
}
export function initialState(chapterId=1,taskId,rulesVersion=DELIVERY_RULES_VERSION) {
  const task = taskFor(chapterId,taskId);
  if (!task) return null;
  const common = {chapterId,taskId:task.id,position:{x:10,y:13}};
  if (chapterId === 1) return {...common,slots:{A:'orange',B:'milk',C:null},holding:null};
  if (chapterId === 4) {
    const orders=rulesVersion===DELIVERY_RULES_VERSION?DELIVERY_MAP.orders:rulesVersion===DELIVERY_RULES_V3?roadsideV3Orders:rulesVersion===SPLIT_DELIVERY_RULES_VERSION?splitDeliveryOrders:legacyDeliveryOrders;
    return {...common,deliveryCoordinates:deliveryCoordinateSystem,deliveryRulesVersion:rulesVersion,timeUnit:'minutes',position:clone(DELIVERY_MAP.points.W),orders:orders.map(order=>({...clone(order),status:'pending',arrivedAt:null})),coins:0,elapsed:0};
  }
  return {...common,flags:{}};
}
export function availableActions(chapterId=1,taskId) {
  return clone(taskFor(chapterId,taskId)?.actions ?? []);
}
export function deliveryPointId(point) {
  return Object.entries(DELIVERY_MAP.points).find(([id,p])=>!id.startsWith('J')&&p.x===point?.x&&p.y===point?.y)?.[0] || '';
}
export function actionLabel(action) {
  if (typeof action === 'string') action = {actionId:action};
  if (!action || typeof action !== 'object') return '未选择操作';
  const params = action.params ?? {};
  if (action.actionId === 'move_crate') return `搬运 ${params.from || '？'} → ${params.to || '？'}`;
  if (action.actionId === 'take') return `领取 ${(Array.isArray(params.items) ? params.items : []).map(id => STOCK_MAP.items[id]?.name || id).join('、') || '商品'}`;
  if (action.actionId === 'deliver') return `送${STOCK_MAP.items[params.item]?.name || '商品'}到${STOCK_MAP.items[params.item]?.shelf || '？'}货架`;
  if (action.actionId === 'move_to') {
    const id=deliveryPointId(params);
    return `移动到${id?' '+id:''}（${params.x ?? '？'}，${params.y ?? '？'}）`;
  }
  if (action.actionId === 'start') return '开始';
  if (action.actionId === 'end') return '结束';
  return TASKS.flatMap(t => t.actions).find(a => a.actionId === action.actionId)?.label ?? '未选择操作';
}

const key = p => `${p.x},${p.y}`;
const same = (a,b) => a.x === b.x && a.y === b.y;
const stockCells = new Map();
for (const [from,to] of STOCK_MAP.links) {
  const a = STOCK_MAP.points[from], b = STOCK_MAP.points[to];
  const distance = Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
  for (let i=0;i<=distance;i++) {
    const p = {x:a.x+Math.sign(b.x-a.x)*i,y:a.y+Math.sign(b.y-a.y)*i};
    stockCells.set(key(p),p);
  }
}
// Fixed-corridor grid search. Invalid/off-corridor endpoints have no path.
export function pathBetween(from,to) {
  const a = typeof from === 'string' ? STOCK_MAP.points[from] : from;
  const b = typeof to === 'string' ? STOCK_MAP.points[to] : to;
  if (!a || !b || !stockCells.has(key(a)) || !stockCells.has(key(b))) return [];
  const queue = [clone(a)], parents = new Map([[key(a),null]]);
  for (let i=0;i<queue.length;i++) {
    const p = queue[i];
    if (same(p,b)) {
      const path=[];
      for (let current=p;current;current=parents.get(key(current))) path.push(clone(current));
      return path.reverse();
    }
    for (const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]) {
      const next={x:p.x+dx,y:p.y+dy};
      if (stockCells.has(key(next)) && !parents.has(key(next))) {
        parents.set(key(next),p); queue.push(next);
      }
    }
  }
  return [];
}
const deliveryCells = new Map();
for (const [from,to] of DELIVERY_MAP.links) {
  const a=DELIVERY_MAP.points[from],b=DELIVERY_MAP.points[to];
  const distance=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
  for (let i=0;i<=distance;i++) {
    const point={x:a.x+Math.sign(b.x-a.x)*i,y:a.y+Math.sign(b.y-a.y)*i};
    deliveryCells.set(key(point),point);
  }
}
// Exploration may find a route around corners. A programmed move_to is stricter.
export function deliveryPathBetween(from,to) {
  const a=typeof from === 'string' ? DELIVERY_MAP.points[from] : from;
  const b=typeof to === 'string' ? DELIVERY_MAP.points[to] : to;
  if (!a || !b || !Number.isInteger(a.x) || !Number.isInteger(a.y) || !Number.isInteger(b.x) || !Number.isInteger(b.y) || !deliveryCells.has(key(a)) || !deliveryCells.has(key(b))) return [];
  const queue=[{x:a.x,y:a.y}],parents=new Map([[key(a),null]]);
  for (let i=0;i<queue.length;i++) {
    const point=queue[i];
    if (same(point,b)) {
      const path=[];
      for (let current=point;current;current=parents.get(key(current))) path.push(clone(current));
      return path.reverse();
    }
    for (const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]) {
      const next={x:point.x+dx,y:point.y+dy};
      if (deliveryCells.has(key(next)) && !parents.has(key(next))) {parents.set(key(next),point);queue.push(next);}
    }
  }
  return [];
}
function deliveryStraightPath(from,to) {
  if (from.x !== to.x && from.y !== to.y) return {message:'一个移动积木只能沿横向或纵向道路直走；转弯前请添加拐点坐标积木。'};
  const distance=Math.abs(from.x-to.x)+Math.abs(from.y-to.y),path=[clone(from)];
  for (let i=1;i<=distance;i++) {
    const point={x:from.x+Math.sign(to.x-from.x)*i,y:from.y+Math.sign(to.y-from.y)*i};
    if (!deliveryCells.has(key(point))) return {message:'这段直线会穿过楼房或离开道路，请沿道路添加拐点坐标积木。'};
    path.push(point);
  }
  return {path};
}
function localPath(from,to) {
  const p=clone(from), path=[clone(p)];
  // Interactions are on the front aisle; move along that aisle before approaching.
  while (p.y !== 11) {p.y += Math.sign(11-p.y);path.push(clone(p));}
  while (p.x !== to.x) {p.x += Math.sign(to.x-p.x);path.push(clone(p));}
  while (p.y !== to.y) {p.y += Math.sign(to.y-p.y);path.push(clone(p));}
  return path;
}
function parameterProblem(node) {
  const p = node.params;
  if (['move_crate','take','deliver','move_to'].includes(node.actionId) && (!p || typeof p !== 'object' || Array.isArray(p))) return '请补充这一步的操作对象。';
  if (node.actionId === 'move_to' && (!Number.isInteger(p.x) || !Number.isInteger(p.y) || !deliveryCells.has(key(p)))) return '坐标必须是道路上的整数格，请对照地图选择道路坐标。';
  if (node.actionId === 'move_crate' && (!Object.hasOwn(DRINK_POINTS,p.from) || !Object.hasOwn(DRINK_POINTS,p.to) || p.from === p.to)) return '请选择两个不同的合法柜位A、B或C。';
  if (node.actionId === 'take' && (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 2 || Array.from(p.items).some(id => typeof id !== 'string' || !Object.hasOwn(STOCK_MAP.items,id)) || new Set(p.items).size !== p.items.length)) return '每次领取请选择一箱或两箱不同的商品。';
  if (node.actionId === 'deliver' && !Object.hasOwn(STOCK_MAP.items,p.item)) return '请选择要送到货架的商品。';
  return null;
}
export function validateGraph(graph) {
  graph=normalizeDeliveryGraph(graph);
  const errors=[],order=[];
  const error=(code,message,nodeId) => errors.push({...nodeId ? {nodeId} : {},message,code});
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return {ok:false,errors:[{code:'GRAPH',message:'请先画出流程图。'}],order};
  if (graph.taskId === 'delivery' && ![DELIVERY_RULES_VERSION,DELIVERY_RULES_V3,SPLIT_DELIVERY_RULES_VERSION,LEGACY_DELIVERY_RULES_VERSION].includes(deliveryRulesVersion(graph))) error('VERSION','配送规则版本不受支持，请使用当前任务版本。');
  if (graph.schemaVersion !== 1 || graph.contentVersion !== '1.0.0') error('VERSION','流程图版本不受支持，请使用当前任务版本。');
  if (!Number.isInteger(graph.revision) || graph.revision < 0) error('REVISION','流程图修订号必须是非负整数。');
  const task=taskFor(graph.chapterId,graph.taskId);
  if (!task || typeof graph.taskId !== 'string') error('TASK','章节与任务不匹配。');
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return {ok:false,errors:[...errors,{code:'GRAPH',message:'流程图缺少步骤框或连线。'}],order};
  const limit=task?.id === 'delivery' ? 48 : 24;
  if (graph.nodes.length > limit) error('LIMIT',`一张流程图最多${limit}个框。`);
  const nodes = new Map(),incoming=new Map(),outgoing=new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id.trim()) {error('NODE_ID','每个步骤框都需要唯一的编号。');continue;}
    if (nodes.has(node.id)) {error('DUPLICATE_ID','步骤框编号重复。',node.id);continue;}
    nodes.set(node.id,node);incoming.set(node.id,[]);outgoing.set(node.id,[]);
    if (node.label !== undefined && typeof node.label !== 'string') error('LABEL','步骤名称必须是文字。',node.id);
    if (!['start','action','end'].includes(node.kind)) error('NODE_KIND','步骤框类型无效。',node.id);
    if (node.kind === 'action') {
      if (!task?.actions.some(a => a.actionId === node.actionId)) error('ACTION','请选择本任务的合法操作。',node.id);
      else {const problem=parameterProblem(node);if (problem) error('PARAMS',problem,node.id);}
    }
  }
  const starts=[...nodes.values()].filter(n => n.kind === 'start'), ends=[...nodes.values()].filter(n => n.kind === 'end');
  if (starts.length !== 1) error('START','流程图必须恰好有一个开始框。');
  if (ends.length !== 1) error('END','流程图必须恰好有一个结束框。');
  const seenEdges=new Set();
  for (const edge of graph.edges) {
    if (!edge || !nodes.has(edge.from) || !nodes.has(edge.to)) {error('DANGLING_EDGE','连线必须连接已有的步骤框。');continue;}
    const edgeKey=JSON.stringify([edge.from,edge.to]);
    if (seenEdges.has(edgeKey)) error('DUPLICATE_EDGE','两个步骤框之间存在重复连线。',edge.from);
    seenEdges.add(edgeKey);outgoing.get(edge.from).push(edge.to);incoming.get(edge.to).push(edge.from);
  }
  for (const [id,node] of nodes) {
    const needIn=node.kind === 'start' ? 0 : 1,needOut=node.kind === 'end' ? 0 : 1;
    if (incoming.get(id).length !== needIn || outgoing.get(id).length !== needOut) error('CONNECTION','开始无入线、结束无出线，每一步须在一条完整链中。',id);
  }
  // Check every component for cycles, including cycles disconnected from start.
  const colors=new Map();
  const visit=id => {
    if (colors.get(id) === 1) {error('CYCLE','顺序流程图不能有回路。',id);return;}
    if (colors.get(id) === 2) return;
    colors.set(id,1);for (const next of outgoing.get(id)) visit(next);colors.set(id,2);
  };
  if (nodes.size <= 1000) for (const id of nodes.keys()) visit(id);
  else error('LIMIT','步骤框过多，无法运行。');
  if (starts.length === 1) {
    const reached=new Set();let current=starts[0].id;
    while (current && !reached.has(current)) {
      reached.add(current);order.push(current);
      const next=outgoing.get(current);current=next.length === 1 ? next[0] : null;
    }
    for (const id of nodes.keys()) if (!reached.has(id)) error('UNREACHABLE','这个框不在从开始到结束的完整链中。',id);
    if (ends.length === 1 && order.at(-1) !== ends[0].id) error('CHAIN','请把所有步骤连接到结束框。');
  }
  return {ok:errors.length === 0,errors,order};
}

const dependencies={
  wash_orange:[],peel_cut:['wash_orange'],add_orange:['peel_cut'],start_juicer:['add_orange'],pack_juice:['start_juicer'],
  seaweed:[],rice:['seaweed'],filling:['rice'],roll:['filling'],pack:['roll'],
  cup:[],water:['cup'],steep:['water'],remove_bag:['steep'],lid:['remove_bag'],
  soil:[],plant:['soil'],fill:['plant'],water_plant:['fill'],label_plant:['fill'],
  fishfood:[],open_feed:[],feed:['fishfood','open_feed'],close_feed:['feed'],record_feed:['feed']
};
function goalProblem(state,task) {
  if (state.chapterId === 1) return state.slots.A === 'milk' && state.slots.B === 'orange' && state.slots.C === null && state.holding === null ? null : '还没有交换好：A需要牛奶，B需要橙汁，C应为空。';
  if (state.chapterId === 4) {
    const missing=Object.values(STOCK_MAP.items).filter(item => state.shelves[item.shelf] !== item.id);
    if (missing.length) return `还有${missing.map(item=>item.name).join('、')}没有送到指定货架。`;
    if (state.location !== 'W') return '商品已上架，请返回仓库W交接。';
    if (state.inventory.length) return '交接时小车需要空着。';
    return null;
  }
  const missing=task.actions.filter(a => !state.flags[a.actionId]);
  return missing.length ? `任务还未完成，尚需完成“${missing[0].label}”。` : null;
}
// Check an entire step before any walking or handling; a rejected step is atomic.
function precondition(state,node) {
  const p=node.params ?? {};
  if (node.actionId === 'move_crate') {
    if (state.slots[p.from] === null) return `${p.from}柜现在是空的，没有饮料箱可搬。`;
    if (state.slots[p.to] !== null) return `${p.to}柜已经有饮料箱，需要先腾出位置。`;
  } else if (node.actionId === 'take') {
    if (state.location !== 'W') return '领取商品前，请先返回仓库W。';
    if (state.inventory.length+p.items.length > STOCK_MAP.capacity) return '小车最多装两箱，请先送走车上的商品。';
    if (p.items.some(id => !state.stock.includes(id))) return '这些商品已经领取过了，每箱商品只有一份。';
  } else if (node.actionId === 'deliver') {
    if (!state.inventory.includes(p.item)) return `小车上没有${STOCK_MAP.items[p.item].name}，请先领取。`;
    if (state.shelves[STOCK_MAP.items[p.item].shelf] !== null) return '这个货架已经上架，不能重复放置。';
  } else if (node.actionId !== 'return') {
    if (state.flags[node.actionId]) return '这一步已经完成，不能重复添加或操作。';
    const missing=dependencies[node.actionId].find(id => !state.flags[id]);
    if (missing) return `现在还不能“${actionLabel(node)}”，请先完成“${actionLabel(missing)}”。`;
  }
  return null;
}
function simulateDelivery(graph,validation,first,result) {
  const state=clone(first),nodes=new Map(graph.nodes.map(node=>[node.id,node]));
  const metrics=result.metrics;
  const refresh=()=>{
    metrics.total=metrics.walk+metrics.handling;
    metrics.coins=state.coins;
    metrics.delivered=state.orders.filter(order=>order.status === 'delivered').length;
    metrics.failed=state.orders.filter(order=>order.status === 'spoiled').length;
    metrics.onTime=metrics.delivered === state.orders.length;
  };
  const fail=(nodeId,message,code)=>{refresh();return {...result,finalState:clone(state),errorNodeId:nodeId,message,errors:[{nodeId,message,code}]};};
  for (const nodeId of validation.order) {
    const node=nodes.get(nodeId),before=clone(state),events=[];
    const actionId=node.kind === 'action' ? node.actionId : node.kind;
    if (node.kind === 'action') {
      const movement=deliveryStraightPath(state.position,node.params);
      if (movement.message) return fail(nodeId,movement.message,'ROAD');
      let segment=[clone(state.position)];
      const flushWalk=(roadDelay=null)=>{
        if (segment.length < 2) return;
        const duration=(segment.length-1)*DELIVERY_MAP.minutesPerCell+(roadDelay?.minutes||0);
        metrics.walk+=duration;
        events.push({type:'walk',actionId,from:clone(segment[0]),to:clone(segment.at(-1)),path:clone(segment),duration,...(roadDelay?{roadDelay:clone(roadDelay)}:{}),state:clone(state)});
        segment=[clone(state.position)];
      };
      for (const point of movement.path.slice(1)) {
        const roadDelay=deliveryRoadDelay(state.position,point,state.deliveryRulesVersion);
        if(roadDelay)flushWalk();
        state.position=clone(point);state.elapsed+=DELIVERY_MAP.minutesPerCell+(roadDelay?.minutes||0);segment.push(clone(point));
        if(roadDelay)flushWalk(roadDelay);
        const order=state.orders.find(order=>order.status === 'pending' && same(DELIVERY_MAP.points[order.point],point));
        if (order) {
          flushWalk();
          order.arrivedAt=state.elapsed;
          order.status=order.arrivedAt <= order.deadline ? 'delivered' : 'spoiled';
          const reward=order.status === 'delivered' ? order.baseReward+Math.floor((order.deadline-order.arrivedAt)/DELIVERY_MAP.bonusEveryMinutes) : -order.penalty;
          state.coins+=reward;state.elapsed+=DELIVERY_MAP.handlingMinutes;metrics.handling+=DELIVERY_MAP.handlingMinutes;
          events.push({type:'delivery',actionId,orderId:order.id,point:order.point,status:order.status,arrivedAt:order.arrivedAt,coins:reward,reward,duration:DELIVERY_MAP.handlingMinutes,state:clone(state)});
        }
      }
      flushWalk();
    }
    refresh();
    const duration=state.elapsed-before.elapsed;
    result.trace.push({nodeId,actionId,params:clone(node.params ?? {}),label:node.label?.trim() || actionLabel({...node,actionId}),before,after:clone(state),events,duration,cumulative:state.elapsed});
    if (node.kind === 'end' && state.orders.some(order=>order.status === 'pending')) return fail(nodeId,'还有订单未送到，请沿道路移动到全部六个地址。','GOAL');
  }
  return {...result,ok:true,completed:true,finalState:clone(state),message:metrics.failed ? `六单已处理，${metrics.failed}单超时。调整路线再试试！` : '六单全部按时送达！'};
}
export function simulate(graph,options={}) {
  graph=normalizeDeliveryGraph(graph);
  options=options && typeof options === 'object' ? options : {};
  const chapterId=options.chapterId ?? graph?.chapterId ?? 1,taskId=options.taskId ?? graph?.taskId ?? DEFAULT_TASK[chapterId];
  const first=initialState(chapterId,taskId,deliveryRulesVersion(graph)),task=taskFor(chapterId,taskId);
  const result={ok:false,completed:false,...(chapterId === 4 ? {deliveryCoordinates:deliveryCoordinateSystem,deliveryRulesVersion:deliveryRulesVersion(graph),timeUnit:'minutes'} : {}),errors:[],trace:[],initialState:clone(first),finalState:clone(first),metrics:{walk:0,handling:0,total:0,onTime:false,...(chapterId === 4 ? {coins:0,delivered:0,failed:0} : {})}};
  const validation=validateGraph(graph);
  if (!validation.ok) return {...result,errors:validation.errors,errorNodeId:validation.errors.find(e=>e.nodeId)?.nodeId,message:validation.errors[0].message};
  if (!task || graph.chapterId !== chapterId || graph.taskId !== taskId) return {...result,errors:[{code:'TASK',message:'流程图与本次运行的任务不一致。'}],message:'流程图与本次运行的任务不一致。'};
  if (task.id === 'delivery') return simulateDelivery(graph,validation,first,result);
  let state=clone(first), cumulative=0;
  const nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  const fail=(nodeId,message,code) => ({...result,finalState:clone(state),errorNodeId:nodeId,message,errors:[{nodeId,message,code}]});
  for (const nodeId of validation.order) {
    const node=nodes.get(nodeId),before=clone(state),events=[];
    const actionId=node.kind === 'action' ? node.actionId : node.kind;
    const label=node.label?.trim() || actionLabel({...node,actionId});
    const emit=(event) => events.push({...event,state:clone(state)});
    const walk=(target,location) => {
      const path=chapterId === 4 ? pathBetween(state.position,target) : same(state.position,target) ? [clone(target)] : localPath(state.position,target);
      if (path.length <= 1) return;
      const from=clone(state.position);state.position=clone(target);
      if (location) state.location=location;
      emit({type:'walk',from,to:clone(target),path,duration:path.length-1});
      if (chapterId === 4) result.metrics.walk += path.length-1;
    };
    const handle=(event) => {emit({...event,duration:1});if (chapterId === 4) result.metrics.handling++;};
    if (node.kind === 'action') {
      const problem=precondition(state,node);
      if (problem) return fail(nodeId,problem,'PRECONDITION');
      const p=node.params ?? {};
      if (actionId === 'move_crate') {
        walk(DRINK_POINTS[p.from]);
        const item=state.slots[p.from];state.slots[p.from]=null;state.holding=item;
        handle({type:'take',item,from:clone(state.position),actionId});
        walk(DRINK_POINTS[p.to]);state.slots[p.to]=item;state.holding=null;
        handle({type:'place',item,to:clone(state.position),actionId});
      } else if (actionId === 'take') {
        for (const item of p.items) {
          state.stock=state.stock.filter(id=>id!==item);state.inventory.push(item);
          handle({type:'take',item,from:clone(state.position),actionId});
        }
      } else if (actionId === 'deliver') {
        const item=p.item,shelf=STOCK_MAP.items[item].shelf;
        walk(STOCK_MAP.points[shelf],shelf);
        state.inventory=state.inventory.filter(id=>id!==item);state.shelves[shelf]=item;
        handle({type:'place',item,to:clone(state.position),actionId});
      } else if (actionId === 'return') {
        walk(STOCK_MAP.points.W,'W');state.location='W';
      } else {
        walk(WORK_POINTS[taskId]);state.flags[actionId]=true;
        emit({type:'action',actionId,duration:actionId === 'steep' ? 3 : 2});
      }
    }
    const duration=events.reduce((sum,e)=>sum+e.duration,0);cumulative+=duration;
    result.trace.push({nodeId,actionId,params:clone(node.params ?? {}),label,before,after:clone(state),events,duration,cumulative});
    result.metrics.total=result.metrics.walk+result.metrics.handling;
    if (node.kind === 'end') {
      const problem=goalProblem(state,task);
      if (problem) return fail(nodeId,problem,'GOAL');
    }
  }
  return {...result,ok:true,completed:true,finalState:clone(state),metrics:{...result.metrics,onTime:chapterId !== 4 || result.metrics.total <= STOCK_MAP.targetSeconds},message:chapterId === 4 && result.metrics.total > STOCK_MAP.targetSeconds ? '商品已放对并完成交接，再试试减少往返。' : '任务完成！'};
}
export function buildGraph(actions=[],options={}) {
  options=options && typeof options === 'object' ? options : {};
  const normalized=(Array.isArray(actions) ? actions : []).map(a => typeof a === 'string' ? {actionId:a} : (a && typeof a === 'object' ? clone(a) : {}));
  const inferred=TASKS.find(t => normalized.length && t.actions.some(a=>a.actionId === normalized[0]?.actionId));
  const chapterId=options.chapterId ?? inferred?.chapterId ?? 1, taskId=options.taskId ?? inferred?.id ?? DEFAULT_TASK[chapterId];
  const nodes=[{id:'start',kind:'start'},...normalized.map((a,i)=>({...a,id:`step-${i+1}`,kind:'action',params:clone(a.params ?? {})})),{id:'end',kind:'end'}];
  return {schemaVersion:1,chapterId,taskId,contentVersion:'1.0.0',...(taskId === 'delivery' ? {deliveryCoordinates:DELIVERY_MAP.coordinateSystem,deliveryRulesVersion:DELIVERY_RULES_VERSION} : {}),revision:options.revision ?? 0,nodes,edges:nodes.slice(1).map((n,i)=>({from:nodes[i].id,to:n.id}))};
}
export function exampleGraph(chapterId=1,taskId,variant='best') {
  if (['best','good','demo','bad','cross','alternate','alternative','reverse','empty'].includes(taskId)) {variant=taskId;taskId=undefined;}
  const task=taskFor(chapterId,taskId);
  if (!task) return buildGraph([],{chapterId,taskId});
  let actions;
  if (variant === 'empty') actions=[];
  else if (chapterId === 1) {
    const alternate=['alternate','alternative','reverse'].includes(variant);
    actions=(alternate ? [['B','C'],['A','B'],['C','A']] : [['A','C'],['B','A'],['C','B']]).map(([from,to])=>({actionId:'move_crate',params:{from,to}}));
  } else if (chapterId === 4) {
    // v4's reference route visits each address once and keeps both cold
    // orders inside their 30-minute windows. The older examples remain useful
    // as a slower success and a clear late-A comparison.
    const points=['cross','bad','alternate','alternative','reverse'].includes(variant) ? ['H','B','E','F','C','B','A','D'] : ['good','demo'].includes(variant) ? ['H','B','E','D','A','B','C','F'] : ['H','B','A','D','E','F','C'];
    actions=points.map(point=>({actionId:'move_to',params:clone(DELIVERY_MAP.points[point])}));
  } else {
    actions=task.actions.map(a=>({actionId:a.actionId}));
    if (['alternate','alternative','reverse'].includes(variant) && ['plant','fish'].includes(task.id)) {
      [actions[3],actions[4]]=[actions[4],actions[3]];
      if (task.id === 'fish') [actions[0],actions[1]]=[actions[1],actions[0]];
    }
    if (['cross','bad'].includes(variant)) [actions[0],actions[1]]=[actions[1],actions[0]];
  }
  return buildGraph(actions,{chapterId,taskId:task.id});
}
