import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import * as engine from './shared/engine.mjs';
const ROOT=dirname(fileURLToPath(import.meta.url));
const uid=()=>randomBytes(16).toString('hex');
const hash=s=>createHash('sha256').update(s).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const taskFor=(chapter,l)=>({1:'drink-swap',2:'fresh-juice',3:l.taskId,4:'delivery'}[chapter]);
export function createClassroomServer({dataDir=process.env.SUPERMARKET_DATA_DIR||join(ROOT,'data'), teacherKey, publicUrl=process.env.SUPERMARKET_PUBLIC_URL||''}={}) {
 const external=publicUrl?new URL(publicUrl):null;
 if(external&&(!['http:','https:'].includes(external.protocol)||external.username||external.password||external.pathname!=='/'||external.search||external.hash))throw new Error('SUPERMARKET_PUBLIC_URL 必须是完整的 http(s) 站点地址，不含路径、账号或查询参数');
 const publicOrigin=external?.origin;
 const cookieSecurity=external?.protocol==='https:'?'; Secure':'';
 mkdirSync(dataDir,{recursive:true});
 const keyFile=join(dataDir,'teacher-key.txt');
 const configuredKey=process.env.SUPERMARKET_TEACHER_PASSWORD||teacherKey;
 if (!existsSync(keyFile)) writeFileSync(keyFile,configuredKey||randomBytes(18).toString('base64url'),{mode:0o600});
 const key=configuredKey||readFileSync(keyFile,'utf8').trim(),teacherKeyHash=hash(key);
 const db=new DatabaseSync(join(dataDir,'supermarket.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,sessionId TEXT,learnerId TEXT,json TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS records_session ON records(kind,sessionId); CREATE INDEX IF NOT EXISTS records_learner ON records(kind,learnerId);');
 // Keep historical JSON intact; index its existing timestamp once for incremental reads.
 if(!db.prepare('PRAGMA table_info(records)').all().some(c=>c.name==='changedAt')){
  db.exec("BEGIN IMMEDIATE; ALTER TABLE records ADD COLUMN changedAt INTEGER NOT NULL DEFAULT 0; UPDATE records SET changedAt=COALESCE(json_extract(json,'$.updatedAt'),json_extract(json,'$.createdAt'),0); COMMIT;");
 }
 db.exec('CREATE INDEX IF NOT EXISTS records_session_changed ON records(kind,sessionId,changedAt); CREATE INDEX IF NOT EXISTS records_learner_changed ON records(kind,learnerId,changedAt); CREATE INDEX IF NOT EXISTS records_session_all ON records(sessionId);');
 // Only fixed query shapes enter this cache; request values stay bound parameters.
 const statements=new Map();
 const statement=sql=>{if(!statements.has(sql))statements.set(sql,db.prepare(sql));return statements.get(sql);};
 const get=(kind,id)=>{const r=statement('SELECT json FROM records WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.json):null;};
 const all=(kind,{sessionId,learnerId,since}={})=>{let sql='SELECT json FROM records WHERE kind=?',args=[kind];if(sessionId){sql+=' AND sessionId=?';args.push(sessionId);}if(learnerId){sql+=' AND learnerId=?';args.push(learnerId);}if(since>0){sql+=' AND changedAt>=?';args.push(since-1);}return statement(sql+' ORDER BY rowid').all(...args).map(r=>JSON.parse(r.json));};
 const put=(kind,obj)=>{statement('INSERT INTO records(kind,id,sessionId,learnerId,json,changedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET sessionId=excluded.sessionId,learnerId=excluded.learnerId,json=excluded.json,changedAt=excluded.changedAt').run(kind,obj.id,obj.sessionId||null,obj.learnerId||null,JSON.stringify(obj),Number(obj.updatedAt||obj.createdAt)||0);return obj;};
 let teacherCredentials=get('settings','teacher-credentials');
 if(teacherCredentials?.keyHash!==teacherKeyHash)teacherCredentials=put('settings',{id:'teacher-credentials',keyHash:teacherKeyHash,version:uid()});
 const teacherCredentialVersion=teacherCredentials.version;
 const setCurrent=id=>put('settings',{id:'current-classroom',currentSessionId:id,updatedAt:Date.now()});
 // Migrate once. A deliberately empty current classroom must stay empty on restart.
 if(!get('settings','current-classroom'))setCurrent(all('session').reverse().filter(s=>s.phase!=='ended').sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]?.id||null);
 const currentSession=()=>{const id=get('settings','current-classroom')?.currentSessionId,s=id?get('session',id):null;return s&&s.phase!=='ended'?s:null;};
 const validDeviceToken=token=>typeof token==='string'&&/^[-_A-Za-z0-9]{32,256}$/.test(token);
 const publicSession=s=>s?Object.fromEntries(['id','name','chapterId','phase','version'].map(k=>[k,s[k]])):null;
 const fail=(status,message,extra={})=>{throw Object.assign(new Error(message),{status,extra});};
 const streams=new Set();
 // A live browser nonce is independent of disk-cloned device credentials.
 const browserClaims=new Map();
 const browserHash=req=>{const token=req.headers['x-supermarket-browser']||new URL(req.url,'http://localhost').searchParams.get('browser');return validDeviceToken(token)?hash(token):null;};
 const activeClaim=id=>{const claim=browserClaims.get(id);if(!claim)return null;if(Date.now()-claim.seen<45000||[...streams].some(c=>c.learnerId===id&&c.browserHash===claim.hash&&!c.res.destroyed))return claim;browserClaims.delete(id);return null;};
 const claimBrowser=(id,value)=>browserClaims.set(id,{hash:value,seen:Date.now()});
 const safeLearner=l=>{if(!l)return null;const {credentialVersion,...v}=l;return {...v,taskVersion:l.taskVersion||0,online:Date.now()-l.lastSeen<30000};};
 function auth(req,studentOnly=false){const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(c=>c.trim().split('=')));const explicitStudent=studentOnly||req.headers['x-supermarket-role']==='student'||new URL(req.url,'http://localhost').searchParams.get('role')==='student';const roles=explicitStudent?[['sm_student','student']]:[['sm_teacher','teacher'],['sm_student','student']];for(const [cookie,role] of roles){if(!cookies[cookie])continue;const a=get('auth',hash(cookies[cookie]));if(a&&a.role===role&&a.expires>Date.now()){if(role==='teacher'){if(a.teacherCredentialVersion===teacherCredentialVersion)return a;continue;}const l=get('learner',a.learnerId);if(l&&l.credentialVersion===a.credentialVersion)return {...a,learner:l};}}return null;}
 const need=(a,role)=>{if(!a||role&&a.role!==role)fail(403,'请先以正确身份登录');};
 const room=(id,a)=>{const s=get('session',id);if(!s)fail(404,'课堂不存在');need(a);if(a.role!=='teacher'&&a.sessionId!==id)fail(403,'只能查看自己的课堂');return s;};
 // A teacher chapter command starts a new epoch. Personal progress belongs to
 // that epoch, while unlocked history remains available for offline uploads.
 // `personalChapterId` is the learner's newest unlocked station (a frontier that
 // only grows); `personalViewChapterId` is the station the learner looks at now.
 // The view may move back to any unlocked station, but never behind the teacher's
 // current chapter and never beyond the frontier.
 const frontierChapter=(s,l)=>l.personalChapterEpoch===(s.chapterEpoch||0)?Math.max(s.chapterId,l.personalChapterId||s.chapterId):s.chapterId;
 const viewChapter=(s,l)=>{const frontier=frontierChapter(s,l),view=l.personalViewEpoch===(s.chapterEpoch||0)?l.personalViewChapterId:null;return view?Math.min(frontier,Math.max(s.chapterId,view)):frontier;};
 const learnerSession=(s,l)=>{const chapterId=viewChapter(s,l);return {...s,chapterEpoch:s.chapterEpoch||0,chapterId,phase:chapterId!==s.chapterId&&!['paused','ended'].includes(s.phase)?'practice':s.phase,openedChapters:[...new Set([...(s.openedChapters||[]),...(l.personalOpenedChapters||[])])]};};
 const state=(s,a)=>{const currentSessionId=currentSession()?.id||null;if(a.role==='teacher')return {currentSessionId,session:s,learners:all('learner',{sessionId:s.id}).map(safeLearner)};const l=get('learner',a.learnerId),session=learnerSession(s,l),chapterId=session.chapterId,taskId=taskFor(chapterId,l);return {currentSessionId,session,learner:safeLearner(l),floorChapterId:s.chapterId,frontierChapterId:frontierChapter(s,l),assignment:{chapterId,taskId,draftId:`${l.id}-${chapterId}-${taskId}`,taskVersion:l.taskVersion||0}};};
 function works(sessionId,learnerId,since=0,includeHistory=true){const filter=learnerId?{learnerId}:{sessionId},historyFilter={...filter,since};return {learners:learnerId?[safeLearner(get('learner',learnerId))].filter(Boolean):all('learner',filter).map(safeLearner),drafts:all('draft',historyFilter),draftVersions:includeHistory?all('draftVersion',historyFilter):[],conflicts:includeHistory?all('conflict',historyFilter):[],runs:all('run',historyFilter),submissions:all('submission',historyFilter),feedback:all('feedback',historyFilter)};}
 // Overview projection happens inside SQLite, so large run traces and world
 // snapshots never enter the server's JS heap or the teacher's table cache.
 const jsonProjection=(source,fields)=>`(SELECT json_group_object(item.key,json(CASE item.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'text' THEN json_quote(item.value) ELSE item.value END)) FROM json_each(${source}) AS item WHERE item.key IN (${fields.map(k=>`'${k}'`).join(',')}))`;
 const overviewFields={draft:['id','learnerId','sessionId','chapterId','taskId','updatedAt','revision'],run:['id','learnerId','sessionId','chapterId','taskId','createdAt','status','valid','completed','metrics','revision','offline','reason'],submission:['id','learnerId','sessionId','chapterId','taskId','createdAt','source','selfAssessment','explanation','revision','runId']};
 function overviewRecords(kind,sessionId,since){
  let projection=jsonProjection('records.json',overviewFields[kind]);
  if(kind==='run')projection=`json_set(${projection},'$.graph',json(${jsonProjection("json_extract(records.json,'$.graph')",['chapterId','taskId','deliveryRulesVersion','deliveryCoordinates'])}))`;
  let sql=`SELECT ${projection} AS json FROM records WHERE kind=? AND sessionId=?`,args=[kind,sessionId];
  if(since>0){sql+=' AND changedAt>=?';args.push(since-1);}
  return statement(sql+' ORDER BY rowid').all(...args).map(row=>({...JSON.parse(row.json),summary:true}));
 }
 function overviewWorks(sessionId,since){return {summary:true,learners:all('learner',{sessionId}).map(safeLearner),drafts:overviewRecords('draft',sessionId,since),runs:overviewRecords('run',sessionId,since),submissions:overviewRecords('submission',sessionId,since),feedback:all('feedback',{sessionId,since}),draftVersions:[],conflicts:[]};}
 const teacherUpdates=new Map();
 function writeState(c,s,a){if(!a||!s){c.res.end();return;}c.res.write(`event: state\ndata: ${JSON.stringify(state(s,a))}\n\n`);}
 // A burst of student saves/acknowledgments needs one teacher refresh, not one
 // complete class roster per student. Student work does not change peers' state.
 function notifyTeachers(sessionId,{roster=false,works=false}={}){
  const pending=teacherUpdates.get(sessionId);
  if(pending){pending.roster ||= roster;pending.works ||= works;return;}
  const update={roster,works,timer:null};teacherUpdates.set(sessionId,update);
  update.timer=setTimeout(()=>{
   teacherUpdates.delete(sessionId);const s=get('session',sessionId);if(!s)return;
   let snapshot;
   for(const c of streams){if(c.sessionId!==sessionId||c.role!=='teacher')continue;const a=auth(c.req);if(!a){c.res.end();continue;}if(update.roster){snapshot ||= `event: state\ndata: ${JSON.stringify(state(s,a))}\n\n`;c.res.write(snapshot);}if(update.works)c.res.write(`event: works\ndata: ${JSON.stringify({updatedAt:Date.now()})}\n\n`);}
  },100);update.timer.unref();
 }
 function notifyLearner(sessionId,learnerId){for(const c of streams)if(c.sessionId===sessionId&&c.role==='student'&&c.learnerId===learnerId)writeState(c,get('session',sessionId),auth(c.req));}
 function broadcast(sessionId,changed=false){const s=get('session',sessionId);for(const c of streams){if(c.sessionId!==sessionId)continue;const a=auth(c.req);writeState(c,s,a);if(changed&&a?.role==='teacher'&&s)c.res.write(`event: works\ndata: ${JSON.stringify({updatedAt:Date.now()})}\n\n`);}}
 const broadcastCurrent=excludeId=>{for(const id of new Set([...streams].map(c=>c.sessionId)))if(id!==excludeId)broadcast(id);};
 function deleteSessions(ids){
  const selected=new Set(ids),previousCurrent=get('settings','current-classroom')?.currentSessionId;
  db.exec('BEGIN IMMEDIATE');try{
   for(const id of selected)statement("DELETE FROM records WHERE sessionId=? OR learnerId IN (SELECT id FROM records WHERE kind='learner' AND sessionId=?) OR (kind='session' AND id=?)").run(id,id,id);
   if(selected.has(previousCurrent))setCurrent(null);
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  for(const [learnerId] of browserClaims)if(!get('learner',learnerId))browserClaims.delete(learnerId);
  for(const id of selected){const pending=teacherUpdates.get(id);if(pending)clearTimeout(pending.timer);teacherUpdates.delete(id);}
  for(const c of streams)if(selected.has(c.sessionId)){streams.delete(c);c.res.end();}
  if(selected.has(previousCurrent))broadcastCurrent();
  return {deletedCount:selected.size,currentSessionId:currentSession()?.id||null};
 }
 const issue=(res,role,l)=>{const token=uid()+uid();put('auth',{id:hash(token),role,learnerId:l?.id,sessionId:l?.sessionId,credentialVersion:l?.credentialVersion,...(role==='teacher'?{teacherCredentialVersion}:{}),expires:Date.now()+30*86400000});res.setHeader('Set-Cookie',`sm_${role}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${cookieSecurity}`);};
 function newLearner(s,identity){const counts={'rice-roll':0,tea:0,plant:0,fish:0};for(const x of all('learner',{sessionId:s.id}))if(Object.hasOwn(counts,x.taskId))counts[x.taskId]++;const minimum=Math.min(...Object.values(counts)),candidates=Object.keys(counts).filter(id=>counts[id]===minimum),taskId=candidates[Math.floor(Math.random()*candidates.length)];return put('learner',{id:uid(),sessionId:s.id,...identity,taskId,taskVersion:0,credentialVersion:1,lastSeen:Date.now(),appliedVersion:0,receivedVersion:0,chapterId:1,createdAt:Date.now()});}
 const writeGate=(l,chapter,body={},terminal=false)=>{const s=get('session',l.sessionId);if(!s)fail(404,'课堂已删除');const session=learnerSession(s,l);if(body.offline&&!session.openedChapters.includes(chapter))fail(409,'该章节尚未开放，不能补传正式作品');if(chapter!==session.chapterId&&!body.offline&&!terminal)fail(409,'老师已切换章节，请先同步课堂',{session});if(chapter===session.chapterId&&session.phase!=='practice'&&!body.offline&&!terminal)fail(409,'老师尚未开放操作',{session});return s;};
 function graphCheck(g,l){if(!g||![1,2,3,4].includes(g.chapterId)||(g.chapterId===3?!engine.TASKS.some(t=>t.chapterId===3&&t.id===g.taskId):g.taskId!==taskFor(g.chapterId,l)))fail(400,'流程图章节或岗位不匹配');const limit=g.chapterId===4?48:24;if(g.nodes?.length>limit)fail(400,`程序最多${limit}个步骤`);if(JSON.stringify(g).length>120000)fail(413,'流程图过大');}
 const bestRun=runs=>[...runs].sort((a,b)=>(Number(b.metrics?.coins)||0)-(Number(a.metrics?.coins)||0)||(Number(a.metrics?.total)||Infinity)-(Number(b.metrics?.total)||Infinity))[0];
 const comparableRuns=(runs,reference=runs.at(-1)?.graph)=>runs.filter(r=>r.valid&&(r.taskId!=='delivery'||engine.deliveryRulesVersion(r)===engine.deliveryRulesVersion(reference)));
 const deliveryRulesLabel=reference=>{
  const version=engine.deliveryRulesVersion(reference);
  if(version===engine.DELIVERY_RULES_VERSION)return 'A、E冷藏·统筹路线（roadside-v4 当前）';
  if(version===engine.DELIVERY_RULES_V3||version==='roadside-v3')return 'A、E冷藏·慢行路段（roadside-v3 旧版）';
  return version==='split-cold-v2'?'A、E冷藏（split-cold-v2 旧版）':'A、D冷藏（legacy 旧版）';
 };
 function assessmentFor(body,chapterId){const rating=body.selfAssessment;if(Object.hasOwn(body,'selfAssessment')&&(!rating||typeof rating!=='object'||Array.isArray(rating)||rating.goalId!==chapterId||!Number.isInteger(rating.stars)||rating.stars<1||rating.stars>3))fail(400,'自评必须对应本章学习目标，并选择1至3星');return body.source!=='chapter'&&rating?{goalId:chapterId,stars:rating.stars}:null;}
 const latestAssessment=submissions=>submissions.filter(x=>x.source==='student'&&x.selfAssessment).reduce((latest,x)=>!latest||(x.createdAt||0)>=(latest.createdAt||0)?x:latest,null);
 const exportSections=(data,l)=>[1,2,3,4].flatMap(ch=>{const taskIds=ch===3?[...new Set(['drafts','runs','submissions'].flatMap(k=>data[k].filter(x=>x.learnerId===l.id&&x.chapterId===3).map(x=>x.taskId)))]:[null];return (taskIds.length?taskIds:[l.taskId]).map(taskId=>({ch,taskId}));});
 function csv(data){
  const rows=[['组号','姓名','第三章任务','章','完成','提交','运行次数','第四章首次分钟','第四章最新分钟','第四章最佳收益方案分钟','修改理由','第四章首次金币','第四章最新金币','第四章最佳金币','第四章最佳送达','第四章最佳失败','第四章统计规则','学习目标','最新自评星数','满分']];
  for(const l of data.learners)for(const {ch,taskId} of exportSections(data,l)){
   const runs=data.runs.filter(r=>r.learnerId===l.id&&r.chapterId===ch&&(!taskId||r.taskId===taskId)),valid=comparableRuns(runs),sub=data.submissions.filter(r=>r.learnerId===l.id&&r.chapterId===ch&&(!taskId||r.taskId===taskId)),best=bestRun(valid),assessment=latestAssessment(sub);
   rows.push([l.seat,l.name,taskId||l.taskId,ch,valid.length?'已完成':'未完成',sub.length?'已提交':'未提交',runs.length,ch===4?valid[0]?.metrics?.total:'',ch===4?valid.at(-1)?.metrics?.total:'',ch===4?best?.metrics?.total:'',sub.at(-1)?.explanation||'',...['coins','coins','coins','delivered','failed'].map((key,i)=>ch===4?(i===0?valid[0]:i===1?valid.at(-1):best)?.metrics?.[key]:''),ch===4&&runs.at(-1)?.taskId==='delivery'?deliveryRulesLabel(runs.at(-1)): '',engine.LEARNING_GOALS[ch],assessment?.selfAssessment.stars??'',3]);
  }
  return '\ufeff'+rows.map(row=>row.map(x=>'"'+String(x??'').replace(/^[=+@\-\t\r]/,m=>"'"+m).replace(/"/g,'""')+'"').join(',')).join('\r\n');
 }
 function printable(s,data){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(s.name)}作品</title><style>body{font:16px system-ui;margin:30px;color:#153d35}h1,h2{color:#176952}.learner{break-before:page}.learner:first-of-type{break-before:auto}.flow{text-align:center;max-width:480px;margin:20px auto}.node{border:2px solid #176952;padding:12px;border-radius:4px;break-inside:avoid}.node.start,.node.end{border-radius:30px}.arrow{text-align:center;color:#176952}.blocks{max-width:480px;margin:20px auto}.block{background:#4c80d2;color:white;padding:12px;margin-top:-1px;border:1px solid #2857a5;border-radius:8px;break-inside:avoid}.block.start{background:#d79d26}.block.end{background:#8b65b9}article{border-top:1px solid #aaa;padding:15px 0}small{color:#586d65}td,th{border:1px solid #bbb;padding:8px}table{border-collapse:collapse}@media print{button{display:none}}</style><button onclick="print()">打印 / 保存PDF</button><h1>${esc(s.name)} · 超市实践作品</h1>${data.learners.map(l=>`<section class="learner"><h2>${esc(l.seat)}组 ${esc(l.name)}</h2>${exportSections(data,l).map(({ch,taskId})=>{
   const runs=data.runs.filter(r=>r.learnerId===l.id&&r.chapterId===ch&&(!taskId||r.taskId===taskId)),d=data.drafts.find(d=>d.learnerId===l.id&&d.chapterId===ch&&(!taskId||d.taskId===taskId)),latest=runs.at(-1),rawGraph=latest?.graph||d?.graph,g=engine.normalizeDeliveryGraph(rawGraph);if(!g)return `<article>第${ch}章：暂无作品</article>`;
   const submissions=data.submissions.filter(x=>x.learnerId===l.id&&x.chapterId===ch&&(!taskId||x.taskId===taskId)),assessment=latestAssessment(submissions);
   const ordered=engine.validateGraph(g).order||[],nodes=ordered.length?ordered.map(id=>g.nodes.find(n=>n.id===id)).filter(Boolean):g.nodes||[],delivery=g.taskId==='delivery',best=bestRun(comparableRuns(runs,g)),orders=engine.normalizeDeliveryResult(latest?.result,rawGraph)?.finalState?.orders||[];
   return `<article><h3>第${ch}章 · ${esc({1:'饮料区',2:'水果区',3:'实践区',4:'配送区'}[ch]||'')} · ${esc(g.taskId)}</h3><div class="${delivery?'blocks':'flow'}">${nodes.map(n=>`<div class="${delivery?'block':'node'} ${esc(n.kind)}">${esc(delivery&&n.kind==='action'?engine.actionLabel(n):n.label||({start:'开始',end:'结束'}[n.kind])||engine.actionLabel(n))}${n.kind==='action'&&!delivery?`<small>实际操作：${esc(engine.actionLabel(n))}</small>`:''}</div>`).join(delivery?'':'<div class="arrow">↓</div>')}</div><p>${runs.length}次运行；${runs.filter(r=>r.valid).length}次完成${ch===4&&best?.metrics?`；最佳方案：${best.metrics.coins??'—'}金币，${best.metrics.total}分钟，送达${best.metrics.delivered??'—'}单，失败${best.metrics.failed??'—'}单`:''}</p>${delivery&&latest?.metrics?`<p>最新运行：${latest.metrics.coins}金币 · ${latest.metrics.total}分钟 · 送达${latest.metrics.delivered}单 · 失败${latest.metrics.failed}单</p><table><tr><th>订单</th><th>结果</th><th>时限（分钟）</th><th>到达时间（分钟）</th></tr>${orders.map(o=>`<tr><td>${esc(o.name||o.id)}</td><td>${esc(({delivered:'送达',spoiled:'失败：已变质',pending:'待配送'}[o.status])||o.status)}</td><td>${esc(o.deadline??'—')}分钟</td><td>${esc(o.arrivedAt??'—')}分钟</td></tr>`).join('')}</table>`:''}${latest?.result?.errors?.length?`<p>运行提示：${esc(latest.result.errors.map(e=>e.message||e).join('；'))}</p>`:''}${assessment?`<p>学习目标：${esc(engine.LEARNING_GOALS[ch])}；最新自评：${assessment.selfAssessment.stars} / 3星</p>`:''}${submissions.map(x=>`${x.source==='student'&&x.selfAssessment?`<p>自评记录：${esc(engine.LEARNING_GOALS[x.selfAssessment.goalId])} · ${x.selfAssessment.stars} / 3星</p>`:''}${x.explanation?`<p>想法：${esc(x.explanation)}</p>`:''}`).join('')}${data.feedback.filter(x=>x.learnerId===l.id&&x.chapterId===ch).map(x=>`<p>教师反馈：${esc(x.text)}</p>`).join('')}</article>`;
  }).join('')}</section>`).join('')}</html>`;}
 const server=http.createServer(async(req,res)=>{try{
  res.setHeader('X-Content-Type-Options','nosniff');
  const url=new URL(req.url,'http://localhost'),p=url.pathname;const a=auth(req);let b={};
  const browser=browserHash(req);
  if(a?.role==='student'&&browser&&p.startsWith('/api/')&&!['/api/student/auto-join','/api/student/recover','/api/student/current','/api/logout'].includes(p)){
   const claim=activeClaim(a.learnerId);
   if(claim&&claim.hash!==browser)fail(409,'学生身份正在另一台设备使用，请重新领取工牌',{identityMismatch:true});
   claimBrowser(a.learnerId,browser);
  }
  if(p==='/healthz'&&['GET','HEAD'].includes(req.method)){statement('SELECT 1').get();res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify({ok:true}));return;}
  if(['POST','PUT','DELETE'].includes(req.method)){const origin=req.headers.origin;if(origin&&(publicOrigin?new URL(origin).origin!==publicOrigin:new URL(origin).host!==req.headers.host))fail(403,'禁止跨站请求');let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>2000000)fail(413,'上传内容过大');chunks.push(c);}if(size){try{b=JSON.parse(Buffer.concat(chunks));}catch{fail(400,'数据格式错误');}}}
  const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(p==='/api/teacher/login'&&req.method==='POST'){const actual=Buffer.from(hash(String(b.key||''))),expected=Buffer.from(hash(key));if(!timingSafeEqual(actual,expected))fail(403,'教师密钥不正确');issue(res,'teacher');return send({role:'teacher'});}
  if(p==='/api/logout'&&req.method==='POST'){const explicitStudent=req.headers['x-supermarket-role']==='student'||url.searchParams.get('role')==='student';const roles=explicitStudent?['student']:a?.role?[a.role]:['teacher','student'];res.setHeader('Set-Cookie',roles.map(role=>`sm_${role}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecurity}`));return send({ok:true});}
  if(p==='/api/network'){need(a,'teacher');const addresses=publicOrigin||process.env.SUPERMARKET_LAN_DISCOVERY==='0'?[]:Object.values(networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal).map(x=>x.address);const port=server.address()?.port||8790;return send({addresses,studentBaseUrl:publicOrigin||(addresses.length?`http://${addresses[0]}:${port}`:null)});}
  if(p==='/api/me'){return send(a?{role:a.role,...(a.role==='student'?state(get('session',a.sessionId),a):{})}:{role:null});}
  if(p==='/api/student/current'&&req.method==='GET')return send({session:publicSession(currentSession())});
  if(p==='/api/student/auto-join'&&req.method==='POST'){
   if(!validDeviceToken(b.deviceToken))fail(400,'设备凭据必须是32至256位随机字母、数字或横线');
   let joined,resolvedDeviceToken=b.deviceToken;
   if(b.browserToken!==undefined&&!validDeviceToken(b.browserToken))fail(400,'浏览器会话凭据格式错误');
   const joiningBrowser=b.browserToken?hash(b.browserToken):null;
   db.exec('BEGIN IMMEDIATE');
   try{
    const s=currentSession();
    if(s){
     const deviceId=`${s.id}:${hash(b.deviceToken)}`,binding=get('device',deviceId),student=auth(req,true);
     let l=joiningBrowser&&binding?get('learner',binding.learnerId):student?.sessionId===s.id?student.learner:binding?get('learner',binding.learnerId):null;
     if(l&&joiningBrowser){
      const claim=activeClaim(l.id);
      if(claim&&claim.hash!==joiningBrowser){
       // Deterministic split makes a lost response/retry enroll only once.
       resolvedDeviceToken=hash(`split:${b.deviceToken}:${b.browserToken}`);
       const splitBinding=get('device',`${s.id}:${hash(resolvedDeviceToken)}`);
       l=splitBinding?get('learner',splitBinding.learnerId):null;
      }
     }
     if(l?.sessionId!==s.id)l=null;
     if(!l){
      const learners=all('learner',{sessionId:s.id});let n=Math.max(0,...learners.map(x=>Number(/^A([1-9]\d*)$/.exec(x.autoCode||x.seat)?.[1])||0))+1;
      while(learners.some(x=>x.seat===`A${n}`||x.autoCode===`A${n}`))n++;
      l=newLearner(s,{autoCode:`A${n}`,seat:`A${n}`,name:`A${n}`});
     }
     l.lastSeen=Date.now();put('learner',l);put('device',{id:`${s.id}:${hash(resolvedDeviceToken)}`,sessionId:s.id,learnerId:l.id});
     if(joiningBrowser)claimBrowser(l.id,joiningBrowser);
     joined=state(s,{role:'student',sessionId:s.id,learnerId:l.id,learner:l});
     issue(res,'student',l);
    }
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   if(!joined)return send({session:null,learner:null});
   notifyTeachers(joined.session.id,{roster:true});return send({...joined,...(joiningBrowser?{deviceToken:resolvedDeviceToken}:{})});
  }
  if(p==='/api/sessions/ended'&&req.method==='DELETE'){need(a,'teacher');if(b.confirm!=='清理已结束课堂')fail(400,'请输入“清理已结束课堂”确认');return send(deleteSessions(all('session').filter(s=>s.phase==='ended').map(s=>s.id)));}
  if(p==='/api/sessions'){need(a,'teacher');if(req.method==='GET')return send({sessions:all('session').reverse(),currentSessionId:currentSession()?.id||null});if(req.method==='POST'){let code;do{code=String(Math.floor(100000+Math.random()*900000));}while(all('session').some(s=>s.code===code));const s=put('session',{id:uid(),name:String(b.name||'超市实践课堂').slice(0,80),code,chapterId:1,chapterEpoch:0,phase:'waiting',version:1,createdAt:Date.now()});setCurrent(s.id);broadcastCurrent();return send({session:s,joinUrl:`${publicOrigin||(req.headers.host?.includes('localhost')?'http://'+(Object.values(networkInterfaces()).flat().find(x=>x.family==='IPv4'&&!x.internal)?.address||'localhost')+':'+(req.headers.host.split(':')[1]||8790):'http://'+req.headers.host)}/`},201);}}
  if(p==='/api/student/join'&&req.method==='POST'){const s=all('session').find(s=>s.code===String(b.code).trim());if(!s)fail(404,'课堂码不存在');if(s.phase==='ended')fail(409,'课堂已结束');const seat=String(b.seat||'').trim().slice(0,30),name=String(b.name||'').trim().slice(0,60);if(!seat||!name)fail(400,'请填写组号和姓名');let l=all('learner',{sessionId:s.id}).find(l=>l.seat===seat);if(l&&a?.learnerId!==l.id)fail(409,'该组已加入，请老师生成身份恢复码');if(!l)l=newLearner(s,{seat,name});issue(res,'student',l);notifyTeachers(s.id,{roster:true});return send({...state(s,{role:'student',sessionId:s.id,learnerId:l.id,learner:l}),taskId:l.taskId});}
  if(p==='/api/student/recover'&&req.method==='POST'){
   const recovery=get('recovery',hash(String(b.recoveryCode||''))),s=recovery?get('session',recovery.sessionId):null;
   if(!s||s.phase==='ended'||b.code!==undefined&&s.code!==String(b.code)||!recovery||recovery.used||recovery.expires<Date.now())fail(403,'恢复码无效或已使用');
   if(b.deviceToken!==undefined&&!validDeviceToken(b.deviceToken))fail(400,'设备凭据格式错误');
   const l=get('learner',recovery.learnerId);if(!l)fail(403,'恢复码无效或已使用');
   db.exec('BEGIN IMMEDIATE');try{
    browserClaims.delete(l.id);if(browser)claimBrowser(l.id,browser);
    l.credentialVersion++;l.lastSeen=Date.now();put('learner',l);put('recovery',{...recovery,used:true});
    statement('DELETE FROM records WHERE kind=? AND learnerId=?').run('device',l.id);
    if(b.deviceToken)put('device',{id:`${s.id}:${hash(b.deviceToken)}`,sessionId:s.id,learnerId:l.id});
    issue(res,'student',l);db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   notifyLearner(s.id,l.id);notifyTeachers(s.id,{roster:true});return send({...state(s,{role:'student',sessionId:s.id,learnerId:l.id,learner:l}),taskId:l.taskId});
  }
  if(p==='/api/teacher/recover'&&req.method==='POST'){need(a,'teacher');const l=get('learner',b.learnerId);if(!l)fail(404,'找不到小组');const recoveryCode=randomBytes(5).toString('hex').toUpperCase();put('recovery',{id:hash(recoveryCode),learnerId:l.id,sessionId:l.sessionId,expires:Date.now()+15*60000});return send({recoveryCode});}
  const match=p.match(/^\/api\/sessions\/([^/]+)(?:\/(state|stream|commands|works|export))?$/);
  if(match){const [,id,op]=match,s=room(id,a);if(!op&&req.method==='DELETE'){need(a,'teacher');if(b.confirmName!==s.name)fail(400,'请输入完整课堂名称确认删除');if(currentSession()?.id===id&&s.phase!=='ended')fail(409,'请先结束当前课堂再删除');return send({ok:true,...deleteSessions([id])});}
   if(op==='state')return send(state(s,a));
   if(op==='stream'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'private, no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`event: state\ndata: ${JSON.stringify(state(s,a))}\n\n`);const c={req,res,sessionId:id,role:a.role,learnerId:a.learnerId,browserHash:browser};streams.add(c);req.on('close',()=>streams.delete(c));return;}
   if(op==='commands'&&req.method==='POST'){need(a,'teacher');if(!b.commandId)fail(400,'缺少指令编号');const prior=get('command',`${id}:${b.commandId}`);if(prior)return send({session:s,duplicate:true});if(b.expectedVersion!==s.version)fail(409,'课堂状态已更新，请刷新后再操作',{session:s});if(s.phase==='ended')fail(409,'课堂已结束');const before=s.chapterId;switch(b.action){case'set-current':break;case'practice':s.phase='practice';s.openedChapters=[...new Set([...(s.openedChapters||[]),s.chapterId])];break;case'pause':if(s.phase!=='paused'){s.previousPhase=s.phase;s.phase='paused';}break;case'resume':s.phase=s.previousPhase||'practice';break;case'next':if(s.chapterId>=4)fail(400,'已是最后一章');s.chapterId++;s.chapterEpoch=(s.chapterEpoch||0)+1;s.phase='practice';s.openedChapters=[...new Set([...(s.openedChapters||[]),s.chapterId])];break;case'chapter':if(![1,2,3,4].includes(b.chapterId))fail(400,'章节无效');s.chapterId=b.chapterId;s.chapterEpoch=(s.chapterEpoch||0)+1;s.phase='practice';s.openedChapters=[...new Set([...(s.openedChapters||[]),s.chapterId])];break;case'end':s.phase='ended';break;default:fail(400,'未知课堂指令');}s.version++;s.updatedAt=Date.now();put('session',s);const previousCurrent=get('settings','current-classroom')?.currentSessionId;if(['set-current','practice','chapter','next','resume'].includes(b.action))setCurrent(id);else if(b.action==='end'&&previousCurrent===id)setCurrent(null);const currentChanged=previousCurrent!==get('settings','current-classroom')?.currentSessionId;put('command',{id:`${id}:${b.commandId}`,sessionId:id,session:clone(s)});if(before!==s.chapterId||s.phase==='ended')for(const d of all('draft',{sessionId:id}).filter(d=>d.chapterId===before)){const sid=`archive-${d.id}-${d.revision}-${s.version}`;put('submission',{id:sid,submissionId:sid,sessionId:id,learnerId:d.learnerId,draftId:d.id,revision:d.revision,chapterId:d.chapterId,taskId:d.taskId,graph:clone(d.graph),source:'chapter',createdAt:Date.now()});}broadcast(id,true);if(currentChanged)broadcastCurrent(id);return send({session:s,currentSessionId:currentSession()?.id||null});}
   if(op==='works'){need(a,'teacher');const since=Number(url.searchParams.get('since')),serverTime=Date.now(),data=url.searchParams.get('view')==='overview'?overviewWorks(id,since):works(id,undefined,since,url.searchParams.get('history')!=='0');return send({...data,incremental:since>0,serverTime});}
   if(op==='export'){need(a,'teacher');let data=works(id);const ch=Number(url.searchParams.get('chapterId')),learnerId=url.searchParams.get('learnerId');if(learnerId)data.learners=data.learners.filter(l=>l.id===learnerId);for(const k of ['drafts','draftVersions','runs','submissions','feedback','conflicts'])data[k]=data[k].filter(x=>(!learnerId||x.learnerId===learnerId)&&(!ch||x.chapterId===ch));const format=url.searchParams.get('format')||'json',out=format==='csv'?csv(data):format==='html'?printable(s,data):JSON.stringify({session:s,timeUnits:{delivery:'minutes',otherTasks:'seconds'},...data},null,2);res.writeHead(200,{'Content-Type':format==='csv'?'text/csv; charset=utf-8':format==='html'?'text/html; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`${format==='html'?'inline':'attachment'}; filename="supermarket-${s.code}.${format}"`,'Cache-Control':'no-store'});res.end(out);return;}}
  const lm=p.match(/^\/api\/learners\/([^/]+)\/works$/);if(lm){need(a);const l=get('learner',lm[1]);if(!l)fail(404,'找不到小组');if(a.role!=='teacher'&&a.learnerId!==l.id)fail(403,'只能查看自己的作品');return send(works(l.sessionId,l.id,0,url.searchParams.get('history')!=='0'));}
  if(p==='/api/teacher/feedback'&&req.method==='POST'){need(a,'teacher');const l=get('learner',b.learnerId);if(!l)fail(404,'找不到小组');const f=put('feedback',{id:uid(),sessionId:l.sessionId,learnerId:l.id,chapterId:Number(b.chapterId),text:String(b.text||'').slice(0,3000),createdAt:Date.now()});notifyLearner(l.sessionId,l.id);notifyTeachers(l.sessionId,{works:true});return send({feedback:f});}
  if(p.startsWith('/api/student/')){need(a,'student');const expectedLearner=req.headers['x-supermarket-learner'];if(expectedLearner!==undefined&&expectedLearner!==a.learnerId)fail(409,'浏览器已切换学生身份，请先恢复当前课堂连接',{identityMismatch:true});const l=get('learner',a.learnerId);
   if(p==='/api/student/chapter'&&req.method==='POST'){
    // A student may look at any station the class has opened, plus the ones they
    // have already unlocked themselves, but never behind the teacher's chapter
    // and never beyond their own frontier.
    const chapterId=Number(b.chapterId);
    if(![1,2,3,4].includes(chapterId))fail(400,'章节无效');
    const s=get('session',l.sessionId);if(!s)fail(404,'课堂已删除');
    const session=learnerSession(s,l),floor=s.chapterId,frontier=frontierChapter(s,l);
    if(session.phase!=='practice')fail(409,'老师尚未开放操作，请等待',{session});
    if(chapterId<floor)fail(409,'老师已经进入后面的章节，请从当前章节继续',{session});
    if(chapterId>frontier)fail(409,'先完成这一站的评价，才能进入下一站',{session});
    l.personalViewChapterId=chapterId;l.personalViewEpoch=s.chapterEpoch||0;l.lastSeen=Date.now();put('learner',l);
    notifyTeachers(l.sessionId,{roster:true});return send(state(s,a));
   }
   if(p==='/api/student/task'&&req.method==='POST'){if(!engine.TASKS.some(t=>t.chapterId===3&&t.id===b.taskId))fail(400,'请选择有效的第三章任务');const s=writeGate(l,3);if(l.taskId!==b.taskId){l.taskId=b.taskId;l.taskVersion=(l.taskVersion||0)+1;l.lastSeen=Date.now();put('learner',l);notifyLearner(l.sessionId,l.id);notifyTeachers(l.sessionId,{roster:true});}return send(state(s,{...a,learner:l}));}
   if(p==='/api/student/works')return send(works(l.sessionId,l.id,0,url.searchParams.get('history')!=='0'));
   if(p==='/api/student/ack'&&req.method==='POST'){const s=get('session',l.sessionId),session=learnerSession(s,l);l.lastSeen=Date.now();l.receivedVersion=Math.max(l.receivedVersion||0,Math.min(Number(b.receivedVersion??b.version)||0,s.version));if(b.chapterId===session.chapterId&&b.version===s.version){l.appliedVersion=s.version;l.chapterId=frontierChapter(s,l);}put('learner',l);notifyTeachers(l.sessionId,{roster:true});return send({ok:true,...state(s,a)});}
   const dm=p.match(/^\/api\/student\/drafts\/([^/]+)$/);
   if(dm&&req.method==='PUT'){
    const g=b.graph;graphCheck(g,l);writeGate(l,g.chapterId,b);if(!b.mutationId)fail(400,'缺少保存编号');
    const mid=`${l.id}:${b.mutationId}`,mutation=get('mutation',mid);if(mutation)return send(mutation.response,mutation.status||200);
    let d=get('draft',dm[1]);if(d&&d.learnerId!==l.id)fail(403,'不能修改其他小组作品');
    if(d&&(d.chapterId!==g.chapterId||d.taskId!==g.taskId))fail(409,'草稿编号属于其他章节或任务，请使用此任务的独立草稿');
    const stable=all('draft',{learnerId:l.id}).find(x=>x.chapterId===g.chapterId&&x.taskId===g.taskId);if(stable&&stable.id!==dm[1])d=stable;
    let response,status=200;
    // A save's current draft, immutable version and retry receipt form one durable
    // unit. One WAL commit also avoids four separate fsyncs on a VPS disk.
    db.exec('BEGIN IMMEDIATE');try{
     if((d?.revision||0)!==b.baseRevision){
      const conflict=put('conflict',{id:uid(),sessionId:l.sessionId,learnerId:l.id,draftId:d?.id||dm[1],chapterId:g.chapterId,taskId:g.taskId,graph:clone(g),baseRevision:b.baseRevision,createdAt:Date.now()});
      response={draft:d,conflict:{id:conflict.id,message:'较新的版本已保存，本地副本已保留，请选择恢复或合并'}};status=409;
      put('mutation',{id:mid,learnerId:l.id,sessionId:l.sessionId,response,status});
     }else{
      const revision=(d?.revision||0)+1;
      d=put('draft',{id:d?.id||dm[1],sessionId:l.sessionId,learnerId:l.id,chapterId:g.chapterId,taskId:g.taskId,revision,graph:{...clone(g),revision},updatedAt:Date.now()});
      put('draftVersion',{...clone(d),id:`${d.id}:${revision}`,draftId:d.id});response={draft:d};
      put('mutation',{id:mid,sessionId:l.sessionId,learnerId:l.id,response});l.lastSeen=Date.now();put('learner',l);
     }
     db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    notifyTeachers(l.sessionId,{works:true});return send(response,status);
   }

   if(p==='/api/student/runs'&&req.method==='POST'){if(!b.runId)fail(400,'缺少运行编号');const prior=get('run',b.runId);if(prior){if(prior.learnerId!==l.id)fail(403,'运行编号已占用');return send({run:prior});}if(!['completed','failed','stopped','interrupted'].includes(b.status))fail(400,'运行状态无效');graphCheck(b.graph,l);writeGate(l,b.graph.chapterId,b,['stopped','interrupted'].includes(b.status));const version=get('draftVersion',`${b.draftId}:${b.revision}`);if(!version||version.learnerId!==l.id)fail(409,'请先保存运行使用的流程图版本');const normalize=g=>{const c=clone(g);delete c.revision;return JSON.stringify(c);};if(normalize(version.graph)!==normalize(b.graph))fail(409,'运行流程图与保存的版本不同');const result=engine.simulate(b.graph,{chapterId:b.graph.chapterId,taskId:b.graph.taskId});const executed=Array.isArray(b.executedNodes)?b.executedNodes:[];if(executed.some(n=>typeof n!=='string'&&(!n||typeof n.nodeId!=='string')))fail(400,'执行步骤编号格式错误');const expected=result.trace.map(t=>t.nodeId);const complete=executed.length===expected.length&&expected.every((id,i)=>id===(typeof executed[i]==='object'?executed[i].nodeId:executed[i]));let traceConsistent=true;if(Array.isArray(b.trace)){const submittedTrace=engine.normalizeDeliveryResult({trace:b.trace,...(b.trace[0]?.before?.deliveryCoordinates?{deliveryCoordinates:b.trace[0].before.deliveryCoordinates}:{})},b.graph).trace;traceConsistent=submittedTrace.length===expected.length&&submittedTrace.every((t,i)=>{const ref=result.trace[i];return t.nodeId===ref?.nodeId&&['actionId','params','before','after','events','duration','cumulative'].every(k=>t[k]===undefined||isDeepStrictEqual(t[k],ref[k]));});}const valid=b.status==='completed'&&result.ok&&result.completed&&complete&&traceConsistent;let prefix=0;while(prefix<expected.length&&expected[prefix]===(typeof executed[prefix]==='object'?executed[prefix]?.nodeId:executed[prefix]))prefix++;const actualTrace=clone(result.trace.slice(0,prefix));const storedResult={...result,completed:valid,trace:actualTrace,finalState:actualTrace.at(-1)?.after||result.initialState,metrics:valid?result.metrics:null,message:valid?result.message:b.status==='interrupted'?'教师切章中断':b.status==='stopped'?'学生主动停止':result.completed?'执行轨迹不完整或不一致':result.message};const run=put('run',{id:b.runId,runId:b.runId,sessionId:l.sessionId,learnerId:l.id,draftId:b.draftId,revision:b.revision,graph:clone(version.graph),chapterId:b.graph.chapterId,taskId:b.graph.taskId,...(b.graph.taskId==='delivery'?{timeUnit:'minutes'}:{}),status:b.status,valid,completed:valid,executedNodes:clone(executed),trace:actualTrace,result:storedResult,metrics:valid?result.metrics:null,offline:!!b.offline,reason:String(b.reason||(!complete&&b.status==='completed'?'执行轨迹不完整':'')).slice(0,500),createdAt:Date.now()});notifyTeachers(l.sessionId,{works:true});return send({run});}
   if(p==='/api/student/submissions'&&req.method==='POST'){
    if(!b.submissionId)fail(400,'缺少提交编号');
    const prior=get('submission',b.submissionId);
    if(prior){if(prior.learnerId!==l.id)fail(403,'提交编号已占用');assessmentFor(b,prior.chapterId);return send({submission:prior,...state(get('session',l.sessionId),a)});}
    const v=get('draftVersion',`${b.draftId}:${b.revision}`);
    if(!v||v.learnerId!==l.id)fail(409,'找不到此流程图版本，请先同步保存');
    const selfAssessment=assessmentFor(b,v.chapterId),s=writeGate(l,v.chapterId,b,b.source==='chapter'),session=learnerSession(s,l),run=b.runId?get('run',b.runId):null;
    if(b.runId&&(!run||run.learnerId!==l.id||run.draftId!==b.draftId||run.revision!==b.revision))fail(400,'运行与提交版本不匹配');
    const unlocksNext=b.source!=='chapter'&&selfAssessment&&v.chapterId<4;
    // Re-rating an older station must never pull the unlocked frontier back.
    const frontier=frontierChapter(s,l),viewing=viewChapter(s,l);
    const advances=unlocksNext&&v.chapterId===viewing&&session.phase!=='ended'&&(b.chapterEpoch===undefined||b.chapterEpoch===session.chapterEpoch);
    const historyChanged=unlocksNext&&!l.personalOpenedChapters?.includes(v.chapterId+1);
    let submission;
    // Keep the receipt and progress in the same commit so retries after a lost
    // response cannot skip a station, including across server restarts.
    db.exec('BEGIN IMMEDIATE');try{
     submission=put('submission',{id:b.submissionId,submissionId:b.submissionId,sessionId:l.sessionId,learnerId:l.id,draftId:b.draftId,revision:b.revision,runId:b.runId,chapterId:v.chapterId,taskId:v.taskId,graph:clone(v.graph),explanation:String(b.explanation||'').slice(0,3000),...(selfAssessment?{selfAssessment}:{}),source:b.source==='chapter'?'chapter':'student',offline:!!b.offline,createdAt:Date.now()});
     // An old epoch cannot overrule a teacher command, but its queued rating
     // still authorizes the following offline station's work to be retained.
     if(historyChanged)l.personalOpenedChapters=[...new Set([...(l.personalOpenedChapters||[]),v.chapterId,v.chapterId+1])];
     if(advances){
      // Only the newest unlocked station moves the learner forward; reviewing an
      // earlier station saves the rating and leaves the view where the student put it.
      const next=v.chapterId+1;l.personalChapterId=Math.max(frontier,next);l.personalChapterEpoch=session.chapterEpoch;
      l.personalViewChapterId=v.chapterId===frontier?next:viewing;l.personalViewEpoch=session.chapterEpoch;
      l.chapterId=l.personalChapterId;
     }
     if(advances||historyChanged){l.lastSeen=Date.now();put('learner',l);}
     db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    if(advances||historyChanged)notifyLearner(l.sessionId,l.id);
    notifyTeachers(l.sessionId,{works:true,roster:!!advances});return send({submission,...state(s,a)});
   }}
  if(p.startsWith('/api/'))fail(404,'接口不存在');
  if(!['GET','HEAD'].includes(req.method))fail(405,'请求方式不支持');
  let relative=decodeURIComponent(p);const shared=relative.startsWith('/shared/');const base=join(ROOT,shared?'shared':'public');relative=shared?relative.slice(7):relative;const file=resolve(base,'.'+(relative==='/'?'/index.html':relative));if(!file.startsWith(base+'/'))fail(403,'禁止访问');const info=await stat(file).catch(()=>null);if(!info?.isFile())fail(404,'页面不存在');const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};const cacheable=/\.(?:js|mjs|css|svg|png|ico|woff2?)$/.test(file)&&p!=='/sw.js';
  // Short edge TTL for unversioned imports; browsers revalidate on every load.
  const etag=`W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const headers={'Content-Type':types[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':cacheable?'public, max-age=0, s-maxage=300, must-revalidate':'no-cache',ETag:etag};
  if((req.headers['if-none-match']||'').split(',').some(tag=>tag.trim()===etag||tag.trim()==='*')){res.writeHead(304,headers);res.end();return;}
  res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:await readFile(file));
 }catch(e){if(!res.headersSent){res.writeHead(e.status||500,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:e.status?e.message:'服务器处理失败',...(e.extra||{})}));}else res.end();if(!e.status)console.error(e);}});
 const timer=setInterval(()=>{for(const c of streams)c.res.write(': heartbeat\n\n');},15000);timer.unref();
 server.on('close',()=>{clearInterval(timer);for(const pending of teacherUpdates.values())clearTimeout(pending.timer);teacherUpdates.clear();for(const c of streams)c.res.end();db.close();});
 const shutdown=()=>{for(const c of streams)c.res.end();return new Promise((done,reject)=>{server.close(error=>error?reject(error):done());server.closeIdleConnections();});};
 return {server,key,db,shutdown};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {server,key,shutdown}=createClassroomServer();
 const port=Number(process.env.PORT||8790);
 server.listen(port,'0.0.0.0',()=>{
  const base=process.env.SUPERMARKET_PUBLIC_URL?new URL(process.env.SUPERMARKET_PUBLIC_URL).origin:`http://localhost:${server.address().port}`;
  console.log(`\n超市社会实践课堂已启动\n教师入口：${base}/teacher.html\n教师密码：${process.env.SUPERMARKET_TEACHER_PASSWORD?'已使用环境变量配置':'保存在数据目录的 teacher-key.txt'}\n`);
  if(process.env.SUPERMARKET_LAN_DISCOVERY!=='0')for(const a of Object.values(networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal))console.log(`学生局域网入口：http://${a.address}:${server.address().port}/`);
 });
 let stopping=false;
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
  if(stopping)return;
  stopping=true;
  const force=setTimeout(()=>server.closeAllConnections(),10000);force.unref();
  shutdown().then(()=>clearTimeout(force),error=>{console.error(error);process.exitCode=1;});
 });
}
