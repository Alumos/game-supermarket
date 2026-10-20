import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createClassroomServer} from '../server.mjs';

async function harness(t){
 const dir=mkdtempSync(join(tmpdir(),'supermarket-maintenance-')),controllers=[];
 let app,base;
 const start=async()=>{app=createClassroomServer({dataDir:dir,teacherKey:'maintenance'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;};
 await start();
 t.after(async()=>{controllers.forEach(c=>c.abort());await app.shutdown();rmSync(dir,{recursive:true,force:true});});
 const call=async(path,{cookie='',method='GET',body,status=200,headers={}}={})=>{const r=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined}),data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return {...data,cookie:r.headers.get('set-cookie')?.split(';')[0]||cookie};};
 const teacher=(await call('/api/teacher/login',{method:'POST',body:{key:'maintenance'}})).cookie;
 const create=async name=>(await call('/api/sessions',{cookie:teacher,method:'POST',body:{name},status:201})).session;
 const command=async(s,action)=>(await call(`/api/sessions/${s.id}/commands`,{cookie:teacher,method:'POST',body:{action,commandId:`${action}-${s.version}`,expectedVersion:s.version}})).session;
 const stream=async(id,cookie)=>{const ctrl=new AbortController();controllers.push(ctrl);const r=await fetch(base+`/api/sessions/${id}/stream`,{headers:{cookie},signal:ctrl.signal}),reader=r.body.getReader();await reader.read();return reader;};
 const seed=(kind,row)=>app.db.prepare('INSERT INTO records(kind,id,sessionId,learnerId,json) VALUES(?,?,?,?,?)').run(kind,row.id,row.sessionId||null,row.learnerId||null,JSON.stringify(row));
 return {call,teacher,create,command,stream,seed,get app(){return app;},restart:async()=>{await app.shutdown();await start();}};
}

test('classroom deletion requires teacher, exact name and ending the active classroom; removes all linked records and streams',async t=>{
 const h=await harness(t),s=await h.create('五年级 · 测试课堂'),path=`/api/sessions/${s.id}`;
 const student=await h.call('/api/student/auto-join',{method:'POST',body:{deviceToken:'maintenance-student-device-0000000001'}});
 await h.call(path,{method:'DELETE',body:{confirmName:s.name},status:403});
 await h.call(path,{cookie:student.cookie,method:'DELETE',body:{confirmName:s.name},status:403});
 for(const body of [{},{confirmName:s.name+' '},{confirmName:'测试课堂'}])await h.call(path,{cookie:h.teacher,method:'DELETE',body,status:400});
 await h.call(path,{cookie:h.teacher,method:'DELETE',body:{confirmName:s.name},status:409});
 await h.call(path,{cookie:h.teacher,method:'DELETE',headers:{origin:'https://other.example'},body:{confirmName:s.name},status:403});
 const ended=await h.command(s,'end');
 for(const kind of ['draft','draftVersion','run','submission','feedback','conflict','mutation','recovery','command'])h.seed(kind,{id:`${kind}-delete`,sessionId:s.id,learnerId:student.learner.id});
 h.seed('auth',{id:'legacy-learner-auth',learnerId:student.learner.id});
 // Let the join's pending roster update finish before watching for stream EOF.
 await new Promise(resolve=>setTimeout(resolve,120));
 const teacherStream=await h.stream(s.id,h.teacher),studentStream=await h.stream(s.id,student.cookie);
 const removed=await h.call(path,{cookie:h.teacher,method:'DELETE',body:{confirmName:ended.name}});
 assert.equal(removed.deletedCount,1);assert.equal(removed.currentSessionId,null);
 for(const reader of [teacherStream,studentStream])assert.equal((await reader.read()).done,true);
 assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM records WHERE sessionId=? OR learnerId=? OR (kind=? AND id=?)').get(s.id,student.learner.id,'session',s.id).n,0);
 await h.call('/api/student/works',{cookie:student.cookie,status:403});
 await h.call(path+'/state',{cookie:h.teacher,status:404});
 assert.equal((await h.call('/api/student/auto-join',{cookie:student.cookie,method:'POST',body:{deviceToken:'maintenance-student-device-0000000001'}})).learner,null);
 assert.equal((await h.call('/api/sessions',{cookie:h.teacher})).sessions.length,0);
 await h.restart();assert.equal((await h.call('/api/student/current')).session,null);
});

test('non-current deletion and confirmed ended cleanup preserve live classrooms and never select another classroom',async t=>{
 const h=await harness(t),old=await h.create('旧课堂'),ended1=await h.command(await h.create('已结束一'),'end'),ended2=await h.command(await h.create('已结束二'),'end'),current=await h.create('正在上课');
 await h.call('/api/sessions/ended',{method:'DELETE',body:{confirm:'清理已结束课堂'},status:403});
 await h.call('/api/sessions/ended',{cookie:h.teacher,method:'DELETE',body:{},status:400});
 await h.call('/api/sessions/ended',{cookie:h.teacher,method:'DELETE',body:{confirm:'清理已结束课堂 '},status:400});
 const deleted=await h.call(`/api/sessions/${old.id}`,{cookie:h.teacher,method:'DELETE',body:{confirmName:old.name}});assert.equal(deleted.currentSessionId,current.id);
 for(const s of [ended1,ended2])h.seed('future-associated-kind',{id:s.id+'-artifact',sessionId:s.id});
 let result=await h.call('/api/sessions/ended',{cookie:h.teacher,method:'DELETE',body:{confirm:'清理已结束课堂'}});assert.equal(result.deletedCount,2);assert.equal(result.currentSessionId,current.id);
 assert.deepEqual((await h.call('/api/sessions',{cookie:h.teacher})).sessions.map(s=>s.id),[current.id]);
 assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM records WHERE kind=?').get('future-associated-kind').n,0);
 result=await h.call('/api/sessions/ended',{cookie:h.teacher,method:'DELETE',body:{confirm:'清理已结束课堂'}});assert.equal(result.deletedCount,0);assert.equal(result.currentSessionId,current.id);
 const alternate=await h.create('仍然保留');await h.command(await h.command(current,'set-current'),'end');
 result=await h.call(`/api/sessions/${current.id}`,{cookie:h.teacher,method:'DELETE',body:{confirmName:current.name}});assert.equal(result.currentSessionId,null);
 await h.restart();assert.equal((await h.call('/api/student/current')).session,null);assert.equal((await h.call('/api/sessions',{cookie:h.teacher})).sessions[0].id,alternate.id);
});

test('bulk deletion rolls back every classroom if a storage failure occurs',async t=>{
 const h=await harness(t),one=await h.command(await h.create('已结束一'),'end'),two=await h.command(await h.create('已结束二'),'end');
 h.seed('protected-work',{id:'protected',sessionId:two.id});
 h.app.db.exec("CREATE TRIGGER test_delete_failure BEFORE DELETE ON records WHEN OLD.kind='protected-work' BEGIN SELECT RAISE(ABORT,'test storage failure'); END;");
 const originalError=console.error;console.error=()=>{};
 try{await h.call('/api/sessions/ended',{cookie:h.teacher,method:'DELETE',body:{confirm:'清理已结束课堂'},status:500});}finally{console.error=originalError;}
 assert.deepEqual(new Set((await h.call('/api/sessions',{cookie:h.teacher})).sessions.map(s=>s.id)),new Set([one.id,two.id]));
 assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM records WHERE kind=?').get('protected-work').n,1);
 h.app.db.exec('DROP TRIGGER test_delete_failure');
 assert.equal((await h.call('/api/sessions/ended',{cookie:h.teacher,method:'DELETE',body:{confirm:'清理已结束课堂'}})).deletedCount,2);
});
