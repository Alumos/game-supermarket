import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createClassroomServer} from '../server.mjs';
import {exampleGraph} from '../shared/engine.mjs';

async function classroom(t){
 const dir=mkdtempSync(join(tmpdir(),'supermarket-progression-')),controllers=[];let app,base,session,sequence=0;
 const clients={},events=new Map();
 const start=async()=>{app=createClassroomServer({dataDir:dir,teacherKey:'progression'});app.server.prependListener('request',(req,res)=>{if(!req.url.includes('/stream'))return;const write=res.write;res.write=function(chunk,...args){if(String(chunk).startsWith('event: state'))events.set(req.headers.cookie,(events.get(req.headers.cookie)||0)+1);return write.call(this,chunk,...args);};});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;};
 await start();t.after(async()=>{controllers.forEach(c=>c.abort());await app.shutdown();rmSync(dir,{recursive:true,force:true});});
 const call=async(path,{who='teacher',method='GET',body,status=200}={})=>{const response=await fetch(base+path,{method,headers:{cookie:clients[who]||'','content-type':'application/json'},body:body?JSON.stringify(body):undefined}),data=await response.json();if(response.headers.get('set-cookie'))clients[who]=response.headers.get('set-cookie').split(';')[0];assert.equal(response.status,status,JSON.stringify(data));return data;};
 await call('/api/teacher/login',{method:'POST',body:{key:'progression'}});({session}=await call('/api/sessions',{method:'POST',body:{name:'个人闯关'},status:201}));
 const command=async(action,extra={})=>{({session}=await call(`/api/sessions/${session.id}/commands`,{method:'POST',body:{action,commandId:`progression-${++sequence}`,expectedVersion:session.version,...extra}}));return session;};
 const state=(who='one')=>call(`/api/sessions/${session.id}/state`,{who});
 const joinStudent=(who,token=`progression-device-${who}-00000000000000001`)=>call('/api/student/auto-join',{who,method:'POST',body:{deviceToken:token}});
 const save=async(who,room,extra={})=>{const graph=exampleGraph(room.assignment.chapterId,room.assignment.taskId,'best');const data=await call(`/api/student/drafts/${room.assignment.draftId}`,{who,method:'PUT',body:{graph,baseRevision:0,mutationId:`save-${++sequence}`,...extra}});return data.draft;};
 const submit=(who,draft,extra={})=>call('/api/student/submissions',{who,method:'POST',body:{submissionId:`submit-${++sequence}`,draftId:draft.id,revision:draft.revision,selfAssessment:{goalId:draft.chapterId,stars:3},...extra}});
 const stream=async who=>{const controller=new AbortController();controllers.push(controller);const response=await fetch(base+`/api/sessions/${session.id}/stream`,{headers:{cookie:clients[who]},signal:controller.signal});await response.body.getReader().read();events.set(clients[who],0);};
 return {call,command,state,join:joinStudent,save,submit,stream,events,clients,get session(){return session;},restart:async()=>{await app.shutdown();await start();}};
}

test('self assessments advance only their learner, unlock immediate operation and stop at station four',async t=>{
 const h=await classroom(t),one=await h.join('one');await h.join('two');await h.command('practice');
 const first=await h.save('one',await h.state());
 // A legacy submission or chapter archive does not count as a self assessment.
 assert.equal((await h.submit('one',first,{selfAssessment:undefined})).session.chapterId,1);
 assert.equal((await h.submit('one',first,{source:'chapter'})).session.chapterId,1);
 await h.stream('one');await h.stream('two');
 const advanced=await h.submit('one',first,{submissionId:'first-rating',selfAssessment:{goalId:1,stars:1},chapterEpoch:0});
 assert.equal(advanced.session.chapterId,2);assert.equal(advanced.session.phase,'practice');assert.equal(advanced.assignment.taskId,'fresh-juice');assert.equal(advanced.learner.id,one.learner.id);assert.deepEqual(advanced.session.openedChapters,[1,2]);
 assert.equal(h.events.get(h.clients.one),1,'personal progression reaches this learner immediately');assert.equal(h.events.get(h.clients.two),0,'a peer receives no personal progression broadcast');
 assert.equal((await h.state('two')).session.chapterId,1);assert.equal((await h.state('teacher')).session.chapterId,1);
 await h.call(`/api/student/drafts/${one.learner.id}-peer-forbidden`,{who:'two',method:'PUT',body:{graph:exampleGraph(2,'fresh-juice','best'),baseRevision:0,mutationId:'cannot-follow-peer'},status:409});
 const second=await h.save('one',advanced);
 // Both response-loss retries and a second offline rating of an old chapter
 // return current authoritative progress without skipping another station.
 const retry=await h.submit('one',first,{submissionId:'first-rating'});assert.equal(retry.session.chapterId,2);assert.equal(retry.submission.id,'first-rating');
 assert.equal((await h.submit('one',first,{offline:true})).session.chapterId,2);
 const thirdState=await h.submit('one',second,{selfAssessment:{goalId:2,stars:2}});assert.equal(thirdState.session.chapterId,3);assert.equal(thirdState.session.phase,'practice');
 const selected=await h.call('/api/student/task',{who:'one',method:'POST',body:{taskId:'tea'}});assert.equal(selected.assignment.chapterId,3);
 const third=await h.save('one',selected),fourthState=await h.submit('one',third);assert.equal(fourthState.session.chapterId,4);assert.equal(fourthState.assignment.taskId,'delivery');
 const fourth=await h.save('one',fourthState);assert.equal((await h.submit('one',fourth)).session.chapterId,4);assert.equal((await h.submit('one',fourth)).session.chapterId,4);
 const works=await h.call('/api/student/works',{who:'one'});assert.equal(works.runs.length,0,'rating alone advances; a successful run is optional');assert.equal(works.drafts.length,4);assert.equal((await h.state('two')).session.chapterId,1);
 const ack=await h.call('/api/student/ack',{who:'one',method:'POST',body:{version:h.session.version,chapterId:4}});assert.equal(ack.learner.chapterId,4);assert.equal(ack.assignment.chapterId,4);
 const staleAck=await h.call('/api/student/ack',{who:'one',method:'POST',body:{version:h.session.version,chapterId:1}});assert.equal(staleAck.learner.chapterId,4);assert.equal(staleAck.session.chapterId,4);
});

test('personal progression survives refresh, auto join, recovery and restart; global pause and end remain authoritative',async t=>{
 const h=await classroom(t),joined=await h.join('one');await h.join('two');await h.command('practice');const first=await h.save('one',await h.state());await h.submit('one',first);
 assert.equal((await h.call('/api/me',{who:'one'})).session.chapterId,2);assert.equal((await h.join('one')).assignment.chapterId,2);
 await h.restart();assert.equal((await h.state()).session.chapterId,2);assert.equal((await h.call('/api/me',{who:'one'})).assignment.chapterId,2);
 const {recoveryCode}=await h.call('/api/teacher/recover',{method:'POST',body:{learnerId:joined.learner.id}});
 const recovered=await h.call('/api/student/recover',{who:'recovered',method:'POST',body:{recoveryCode,deviceToken:'progression-recovered-device-00000000001'}});assert.equal(recovered.assignment.chapterId,2);assert.equal(recovered.session.phase,'practice');h.clients.one=h.clients.recovered;
 await h.command('pause');const paused=await h.state();assert.equal(paused.session.chapterId,2);assert.equal(paused.session.phase,'paused');assert.equal((await h.state('two')).session.phase,'paused');
 await h.call(`/api/student/drafts/${paused.assignment.draftId}`,{who:'one',method:'PUT',body:{graph:exampleGraph(2,'fresh-juice','best'),baseRevision:0,mutationId:'paused'},status:409});
 await h.command('resume');assert.equal((await h.state()).session.phase,'practice');await h.save('one',await h.state());
 await h.command('end');const ended=await h.state();assert.equal(ended.session.phase,'ended');assert.equal(ended.session.chapterId,2);assert.equal((await h.state('two')).session.phase,'ended');
 await h.call(`/api/student/drafts/${ended.assignment.draftId}`,{who:'one',method:'PUT',body:{graph:exampleGraph(2,'fresh-juice','best'),baseRevision:1,mutationId:'ended'},status:409});
});

test('teacher chapter commands force a new practice epoch without losing unlocked offline work or replaying old progress',async t=>{
 const h=await classroom(t);await h.join('one');await h.join('two');await h.command('practice');
 const first=await h.save('one',await h.state()),secondState=await h.submit('one',first,{submissionId:'before-teacher-reset',offline:true,chapterEpoch:0}),second=await h.save('one',secondState,{offline:true});
 assert.equal((await h.submit('one',second,{offline:true,chapterEpoch:0})).session.chapterId,3);
 const priorVersion=h.session.version;await h.command('chapter',{chapterId:1});assert.equal(h.session.phase,'practice');assert.equal(h.session.chapterEpoch,1);assert.ok(h.session.version>priorVersion);
 for(const who of ['one','two']){const forced=await h.state(who);assert.equal(forced.session.chapterId,1);assert.equal(forced.assignment.chapterId,1);assert.equal(forced.session.phase,'practice');}
 assert.equal((await h.submit('one',first,{submissionId:'before-teacher-reset'})).session.chapterId,1,'a duplicate from the previous epoch never advances again');
 const stale=await h.submit('one',first,{offline:true,chapterEpoch:0});assert.equal(stale.session.chapterId,1,'queued ratings from before a teacher reset are retained without overruling it');assert.equal(stale.submission.selfAssessment.stars,3);
 const oldGraph=structuredClone(second.graph);oldGraph.nodes[1].label='离线保留';
 const saved=await h.call(`/api/student/drafts/${second.id}`,{who:'one',method:'PUT',body:{graph:oldGraph,baseRevision:1,mutationId:'retained-second',offline:true}});assert.equal(saved.draft.revision,2);
 assert.equal((await h.submit('one',saved.draft,{offline:true,chapterEpoch:0})).session.chapterId,1,'old chapter uploads never move the learner backward or forward');
 await h.call('/api/student/drafts/unopened-fourth',{who:'one',method:'PUT',body:{graph:exampleGraph(4,'delivery','best'),baseRevision:0,mutationId:'unopened',offline:true},status:409});
 const rerated=await h.submit('one',first,{chapterEpoch:1});assert.equal(rerated.session.chapterId,2);assert.equal(rerated.session.phase,'practice');
 await h.command('chapter',{chapterId:3});assert.equal(h.session.chapterEpoch,2);assert.equal((await h.state()).session.chapterId,3);await h.call('/api/student/task',{who:'one',method:'POST',body:{taskId:'fish'}});
 await h.command('next');assert.equal(h.session.chapterEpoch,3);assert.equal(h.session.chapterId,4);assert.equal(h.session.phase,'practice');assert.equal((await h.state('two')).assignment.chapterId,4);await h.save('two',await h.state('two'));
});

// The server has not seen stations two or three when the teacher overrides the
// local offline journey. Replaying each rating must authorize the next upload
// without restoring that old journey as the learner's current assignment.
for(const target of [1,4,'ended'])test(`continuous offline station work survives a teacher override to ${target}`,async t=>{
 const h=await classroom(t),one=await h.join('one');await h.command('practice');
 const first=await h.save('one',await h.state());
 if(target==='ended')await h.command('end');else await h.command('chapter',{chapterId:target});
 const targetChapter=target==='ended'?1:target,targetPhase=target==='ended'?'ended':'practice';
 for(const chapterId of [1,2,3]){
  const taskId={1:'drink-swap',2:'fresh-juice',3:one.learner.taskId}[chapterId];
  const draft=chapterId===1?first:await h.save('one',{assignment:{chapterId,taskId,draftId:`${one.learner.id}-${chapterId}-${taskId}`}},{offline:true});
  const uploaded=await h.submit('one',draft,{offline:true,chapterEpoch:0});
  assert.equal(uploaded.session.chapterId,targetChapter,'historical uploads preserve the teacher assignment');
  assert.equal(uploaded.session.phase,targetPhase);assert.ok(uploaded.session.openedChapters.includes(chapterId+1));
 }
 const works=await h.call('/api/student/works',{who:'one'});assert.deepEqual(works.drafts.map(x=>x.chapterId),[1,2,3]);assert.deepEqual(works.submissions.filter(x=>x.source==='student').map(x=>x.chapterId),[1,2,3]);
 assert.equal((await h.state()).assignment.chapterId,targetChapter);
});
