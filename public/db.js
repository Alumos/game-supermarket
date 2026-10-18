// Local classroom records never share an origin namespace with the previous game.
const DATABASE = 'supermarket-v1';
const TABLE = 'records';
const PREFIX = 'supermarket-v1:';
const tabId = Math.random().toString(36).slice(2);
let databasePromise;
let clock = 0;
let writes = Promise.resolve();

function unavailable(operation, errors) {
  const error = new Error('无法保存或读取本机作品：浏览器存储不可用。请保留当前页面，检查浏览器的存储空间和隐私设置。');
  error.name = 'StorageUnavailableError';
  error.code = 'STORAGE_UNAVAILABLE';
  error.operation = operation;
  error.causes = errors;
  if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    globalThis.dispatchEvent(new CustomEvent('supermarket-storage-error', {detail:{message:error.message,operation}}));
  }
  return error;
}
function openDatabase() {
  if (databasePromise) return databasePromise;
  const attempt = new Promise((resolve,reject) => {
    if (!globalThis.indexedDB) {reject(new Error('IndexedDB unavailable'));return;}
    let request, settled = false;
    const timer = setTimeout(() => {settled=true;reject(new Error('IndexedDB open timed out'));},2000);
    const finish = (callback,value) => {if (settled) return;settled=true;clearTimeout(timer);callback(value);};
    try {request=globalThis.indexedDB.open(DATABASE,1);} catch (error) {finish(reject,error);return;}
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TABLE)) request.result.createObjectStore(TABLE,{keyPath:'key'});
    };
    request.onsuccess = () => {
      if (settled) {request.result.close();return;}
      const db=request.result;
      db.onversionchange=()=>{db.close();databasePromise=undefined;};
      finish(resolve,db);
    };
    request.onerror=()=>finish(reject,request.error || new Error('IndexedDB open failed'));
    request.onblocked=()=>finish(reject,new Error('IndexedDB upgrade blocked'));
  });
  databasePromise=attempt;
  attempt.catch(()=>{if(databasePromise===attempt) databasePromise=undefined;});
  return attempt;
}
async function idb(operation,key,entry) {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    let transaction,request,result,settled=false;
    const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);callback(value);};
    const timer=setTimeout(()=>{try{transaction?.abort();}catch{}finish(reject,new Error('IndexedDB operation timed out'));},2500);
    try {
      transaction=db.transaction(TABLE,operation==='put'?'readwrite':'readonly');
      const table=transaction.objectStore(TABLE);
      request=operation==='put'?table.put(entry):operation==='get'?table.get(key):table.getAll();
      request.onsuccess=()=>{result=operation==='put'?entry:request.result;};
      request.onerror=()=>finish(reject,request.error || new Error('IndexedDB request failed'));
      transaction.oncomplete=()=>finish(resolve,result);
      transaction.onerror=()=>finish(reject,transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort=()=>finish(reject,transaction.error || new Error('IndexedDB transaction aborted'));
    } catch(error) {finish(reject,error);}
  });
}
function local(operation,key,entry) {
  const storage=globalThis.localStorage;
  if (!storage) throw new Error('localStorage unavailable');
  if(operation==='put') {storage.setItem(PREFIX+key,JSON.stringify(entry));return entry;}
  if(operation==='get') {const raw=storage.getItem(PREFIX+key);return raw===null?undefined:JSON.parse(raw);}
  const entries=[];
  for(let i=0;i<storage.length;i++) {
    const storageKey=storage.key(i);
    if(storageKey?.startsWith(PREFIX)) {
      const raw=storage.getItem(storageKey);
      if(raw!==null) entries.push(JSON.parse(raw));
    }
  }
  return entries;
}
async function both(operation,key,entry) {
  const results=await Promise.allSettled([idb(operation,key,entry),Promise.resolve().then(()=>local(operation,key,entry))]);
  const good=results.filter(r=>r.status==='fulfilled');
  if(!good.length) throw unavailable(operation,results.map(r=>r.reason));
  return good.map(r=>r.value);
}
function newest(entries) {
  let winner;
  for(const entry of entries) {
    if(!entry || typeof entry.key!=='string' || typeof entry.stamp!=='string') continue;
    clock=Math.max(clock,Number(entry.stamp.split('-')[0]) || 0);
    if(!winner || entry.stamp>winner.stamp) winner=entry;
  }
  return winner;
}
function checkKey(key) {
  if(typeof key!=='string') throw new TypeError('存储键必须是文字。');
}
export async function get(key,fallback=null) {
  checkKey(key);await writes;
  const entry=newest(await both('get',key));
  return !entry || entry.deleted ? fallback : entry.value;
}
function write(key,value,deleted) {
  checkKey(key);
  const operation=writes.then(async()=>{
    // Observe previous timestamps before writing, including records from another tab.
    // A failed read does not prevent a write attempt: a quota issue may have cleared.
    try {newest(await both('get',key));} catch {}
    clock=Math.max(Date.now(),clock+1);
    const entry={key,value,deleted,stamp:`${String(clock).padStart(16,'0')}-${tabId}`};
    await both('put',key,entry);
    return value;
  });
  writes=operation.catch(()=>{});
  return operation;
}
export async function put(key,value) {return write(key,value,false);}
export async function set(key,value) {return write(key,value,false);}
// Keep a tombstone in both stores so a temporarily inaccessible backend cannot
// resurrect an uploaded queue entry when it becomes available again.
export async function remove(key) {await write(key,null,true);}
export async function all(prefix='') {
  checkKey(prefix);await writes;
  const lists=await both('all');
  const byKey=new Map();
  for(const entries of lists) for(const entry of entries) {
    if(!entry || typeof entry.key!=='string' || !entry.key.startsWith(prefix)) continue;
    const latest=newest([byKey.get(entry.key),entry]);
    if(latest) byKey.set(entry.key,latest);
  }
  return [...byKey.values()].filter(entry=>!entry.deleted).sort((a,b)=>a.key.localeCompare(b.key)).map(({key,value})=>({key,value}));
}
