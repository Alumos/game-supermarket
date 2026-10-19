import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {withRequestTimeout} from '../public/request-timeout.mjs';

test('request deadline aborts without AbortSignal.timeout and clears after success or failure', async () => {
  const timeoutDescriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
  try {
    let successSignal,failureSignal;
    const result=await withRequestTimeout(async signal=>{successSignal=signal;return {ok:true};},30);
    assert.deepEqual(result,{ok:true});
    const failure=new Error('network unavailable');
    await assert.rejects(withRequestTimeout(async signal=>{failureSignal=signal;throw failure;},30),error=>error===failure);
    await delay(60);
    assert.equal(successSignal.aborted,false,'finished requests release their deadline');
    assert.equal(failureSignal.aborted,false,'failed requests release their deadline');
    await assert.rejects(withRequestTimeout(signal=>new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }),30),{name:'AbortError'});
  } finally {
    Object.defineProperty(AbortSignal,'timeout',timeoutDescriptor);
  }
});

test('request deadline covers the response body and preserves successful HTTP responses', async () => {
  const server=createServer((req,res)=>{
    res.writeHead(200,{'Content-Type':'application/json'});
    if(req.url==='/stalled-body')res.write('{"pending":');
    else res.end(JSON.stringify({ok:true}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await withRequestTimeout(async signal=>{
      const response=await fetch(origin,{signal});
      assert.equal(response.status,200);
      return response.json();
    }),{ok:true});
    let headersReceived=false;
    await assert.rejects(withRequestTimeout(async signal=>{
      const response=await fetch(origin+'/stalled-body',{signal});
      headersReceived=true;
      return response.json();
    },100),{name:'AbortError'});
    assert.equal(headersReceived,true,'a stalled body still times out after the headers arrive');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
