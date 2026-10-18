import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createClassroomServer } from '../server.mjs';

test('container health, configured public origin, secure cookies and stream shutdown survive restart', async () => {
 const dataDir=mkdtempSync(join(tmpdir(),'supermarket-deploy-'));
 let app=createClassroomServer({dataDir,teacherKey:'deployment-test-key',publicUrl:'https://classroom.example'});
 const listen=async()=>{app.server.listen(0,'127.0.0.1');await once(app.server,'listening');return `http://127.0.0.1:${app.server.address().port}`;};
 let base=await listen();
 try {
  const health=await fetch(base+'/healthz');
  assert.deepEqual(await health.json(),{ok:true});
  assert.equal(health.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/healthz',{method:'HEAD'})).status,200);
  const login=await fetch(base+'/api/teacher/login',{method:'POST',headers:{Origin:'https://classroom.example','Content-Type':'application/json'},body:JSON.stringify({key:'deployment-test-key'})});
  assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/; Secure$/);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const network=await fetch(base+'/api/network',{headers:{Cookie:cookie}});
  assert.deepEqual(await network.json(),{addresses:[],studentBaseUrl:'https://classroom.example'});
  const rejected=await fetch(base+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:'https://other.example','X-Forwarded-Proto':'https','Content-Type':'application/json'},body:'{}'});
  assert.equal(rejected.status,403);
  const created=await fetch(base+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:'https://classroom.example','Content-Type':'application/json'},body:'{}'});
  assert.equal(created.status,201);
  const {session,joinUrl}=await created.json();
  assert.equal(joinUrl,`https://classroom.example/?code=${session.code}`);
  const stream=await fetch(base+`/api/sessions/${session.id}/stream`,{headers:{Cookie:cookie}});
  const reader=stream.body.getReader();
  await reader.read();
  await app.shutdown();
  while(!(await reader.read()).done) {}
  app=createClassroomServer({dataDir,publicUrl:'https://classroom.example'});
  base=await listen();
  const restored=await fetch(base+'/api/sessions',{headers:{Cookie:cookie}});
  assert.equal((await restored.json()).sessions[0].id,session.id);
  const relogin=await fetch(base+'/api/teacher/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'deployment-test-key'})});
  assert.equal(relogin.status,200);
 } finally {
  if(app.server.listening)await app.shutdown();
  rmSync(dataDir,{recursive:true,force:true});
 }
});
