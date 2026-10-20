import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'http://localhost:8790';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const cacheName=`supermarket-shell-${version}`;
function worker({offline=false,status=200}={}) {
  const handlers = new Map(), stores = new Map(), fetched = [];
  let skipped = false, claimed = false;
  const storage = name => {
    if (!stores.has(name)) stores.set(name,new Map());
    const records = stores.get(name);
    return {
      async addAll(requests) {for(const request of requests)records.set(new URL(request.url,origin).pathname,new Response('shell:'+new URL(request.url,origin).pathname));},
      async match(path) {return records.get(path)?.clone();},
      async put(path,response) {records.set(path,response);}
    };
  };
  const fakeCaches = {
    async open(name) {return storage(name);},
    async keys() {return [...stores.keys()];},
    async delete(name) {return stores.delete(name);}
  };
  class RelativeRequest extends Request {constructor(path,options) {super(new URL(path,origin),options);}}
  vm.runInNewContext(source,{
    self:{location:{origin},clients:{async claim(){claimed=true;}},async skipWaiting(){skipped=true;},addEventListener(type,handler){handlers.set(type,handler);}},
    caches:fakeCaches,URL,Request:RelativeRequest,
    async fetch(request) {fetched.push(request.url);if(offline)throw new TypeError('offline');return new Response('network',{status});}
  });
  return {
    stores,fetched,
    async lifecycle(type) {let work;handlers.get(type)({waitUntil(promise){work=promise;}});await work;},
    request(path,{method='GET',mode='cors',accept='*/*'}={}) {
      let response;
      handlers.get('fetch')({request:{url:new URL(path,origin).href,method,mode,headers:new Headers({Accept:accept})},respondWith(promise){response=promise;}});
      return response;
    },
    get skipped(){return skipped;},get claimed(){return claimed;}
  };
}

test('service worker precaches complete student shell and cleans only its own old caches',async()=>{
  const sw=worker();
  sw.stores.set('supermarket-shell-0.9.0',new Map());sw.stores.set('old-game-assets',new Map());
  await sw.lifecycle('install');await sw.lifecycle('activate');
  const records=sw.stores.get(cacheName);
  assert.deepEqual([...records.keys()],['/','/index.html','/app.js','/app.css','/world.js','/audio.js','/db.js','/drag-drop.mjs','/request-timeout.mjs','/shared/engine.mjs']);
  assert.equal(sw.stores.has('supermarket-shell-0.9.0'),false);assert.equal(sw.stores.has('old-game-assets'),true);
  assert.equal(sw.skipped,true);assert.equal(sw.claimed,true);
});

test('offline shell restores only student navigation, retaining URL join code outside cache keys',async()=>{
  const sw=worker({offline:true});await sw.lifecycle('install');
  const response=await sw.request('/?code=123456',{mode:'navigate'});
  assert.equal(await response.text(),'shell:/index.html');
  assert.equal(await (await sw.request('/index.html',{mode:'navigate'})).text(),'shell:/index.html');
  for(const path of ['/teacher.html','/teacher','/teacher/export','/missing'])assert.equal(sw.request(path,{mode:'navigate'}),undefined);
  assert.equal([...sw.stores.values()].some(records=>[...records.keys()].some(key=>key.includes('123456'))),false);
});

test('API, SSE, teacher assets, credentials and writes never enter worker cache handling',async()=>{
  const sw=worker();await sw.lifecycle('install');
  for(const path of ['/api','/api/me','/api/sessions/1/stream','/api/sessions/1/export?format=json','/data/teacher-key.txt','/teacher.html','/teacher.js','/teacher.css','/qr.js','https://example.test/app.js'])assert.equal(sw.request(path),undefined,path);
  assert.equal(sw.request('/app.js',{method:'POST'}),undefined);
  assert.equal(sw.request('/app.js',{accept:'text/event-stream'}),undefined);
  assert.equal(sw.fetched.length,0);
});

test('public dependencies use fresh network and fall back to cached modules offline',async()=>{
  const online=worker();await online.lifecycle('install');
  assert.equal(await (await online.request('/app.js?v=2')).text(),'network');
  assert.equal(await online.stores.get(cacheName).get('/app.js').clone().text(),'network');
  assert.equal(online.stores.get(cacheName).has('/app.js?v=2'),false);
  const offline=worker({offline:true});await offline.lifecycle('install');
  for(const path of ['/app.js','/app.css','/world.js','/audio.js','/db.js','/drag-drop.mjs','/request-timeout.mjs','/shared/engine.mjs'])assert.equal(await (await offline.request(path)).text(),'shell:'+path);
});

test('failed student navigation can use shell without caching the error response',async()=>{
  const sw=worker({status:503});await sw.lifecycle('install');
  assert.equal(await (await sw.request('/?code=123456',{mode:'navigate'})).text(),'shell:/index.html');
  assert.equal(await sw.stores.get(cacheName).get('/index.html').clone().text(),'shell:/index.html');
});


test('student and teacher pages expose the official registration link safely',async()=>{
  for(const page of ['index.html','teacher.html']){
    const html=await readFile(new URL('../public/'+page,import.meta.url),'utf8');
    const footer=html.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/)?.[1];
    assert.ok(footer,page+': has a registration footer');
    assert.match(footer,/>苏ICP备2021038338号-1<\/a>/);
    assert.match(footer,/href="https:\/\/beian\.miit\.gov\.cn\/"/);
    assert.match(footer,/target="_blank"/);
    assert.match(footer,/rel="noopener noreferrer"/);
  }
});
