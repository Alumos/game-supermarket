import test from 'node:test';
import assert from 'node:assert/strict';
import {GameAudio} from '../public/audio.js';

function fixture({storageError = false, resumeError = false} = {}) {
  const listeners = new Map(), contexts = [], sources = [], storage = new Map();
  class Node {
    constructor() { this.disconnected = false; }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  const param = () => ({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}});
  class Context {
    constructor() {this.state = 'suspended';this.currentTime = 0;this.sampleRate = 100;this.destination = {};contexts.push(this);}
    createGain() {return Object.assign(new Node(),{gain:param()});}
    createBuffer() {return {getChannelData:() => new Float32Array(35)};}
    createBiquadFilter() {return Object.assign(new Node(),{frequency:param()});}
    source() {
      const source = Object.assign(new Node(),{frequency:param(),stops:[],start(at){this.started = at;},stop(at){this.stops.push(at);}});
      sources.push(source);return source;
    }
    createOscillator() {return this.source();}
    createBufferSource() {return this.source();}
    resume() {if (resumeError) return Promise.reject(new Error('blocked'));this.state = 'running';return Promise.resolve();}
  }
  const document = {visibilityState:'visible',addEventListener(name,fn){listeners.set(name,fn);}};
  const env = {document,AudioContext:Context,navigator:{userActivation:{isActive:false}},get localStorage(){
    if (storageError) throw new Error('storage denied');
    return {getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  }};
  const audio = new GameAudio(env);
  const unlock = async () => {listeners.get('pointerdown')({isTrusted:true});await Promise.resolve();};
  return {audio,env,document,listeners,contexts,sources,storage,unlock};
}

test('audio stays lazy and silent until a trusted gesture, and failed resume is handled', async () => {
  const f = fixture();
  f.audio.step();f.audio.result(true);f.audio.startEvent({}, {type:'walk'});
  f.audio.unlock();f.listeners.get('pointerdown')({isTrusted:false});
  assert.equal(f.contexts.length,0);assert.equal(f.sources.length,0);
  await f.unlock();
  assert.equal(f.contexts.length,1);
  f.audio.step();assert.equal(f.sources.length,1);
  const rejected = fixture({resumeError:true});
  await rejected.unlock();await Promise.resolve();
  rejected.audio.step();assert.equal(rejected.sources.length,0);
});

test('mute cancels scheduled sounds immediately, remembers preference, and skips muted beats', async () => {
  const f = fixture({storageError:true}), owner = {};
  await f.unlock();
  f.audio.startEvent(owner,{type:'action',actionId:'start_juicer'},{duration:1200});
  const active = [...f.sources];assert.ok(active.length > 0);
  assert.doesNotThrow(() => f.audio.setEnabled(false));
  assert.ok(active.every(source=>source.stops.includes(undefined) && source.disconnected));
  assert.equal(f.audio.voices.size,0);
  f.contexts[0].currentTime = 1;
  f.audio.advanceEvent(owner,600,1200);assert.equal(f.sources.length,active.length);
  f.audio.setEnabled(true);
  f.audio.advanceEvent(owner,600,1200);assert.equal(f.sources.length,active.length);
  f.audio.advanceEvent(owner,900,1200);assert.ok(f.sources.length > active.length);
  const saved = fixture();saved.audio.setEnabled(false);
  assert.equal(new GameAudio(saved.env).enabled,false);
});

test('pause silences just its owner, resume does not replay start, stop forgets progression', async () => {
  const f = fixture(), first = {}, second = {};
  await f.unlock();
  f.audio.startEvent(first,{type:'walk'},{duration:2000});
  const firstVoices = [...f.audio.voices];
  f.audio.startEvent(second,{type:'action',actionId:'water'},{duration:2000});
  f.audio.pauseEvent(first);
  assert.ok(firstVoices.every(voice=>voice.source.disconnected));
  assert.ok([...f.audio.voices].every(voice=>voice.owner === second));
  const count = f.sources.length;
  f.contexts[0].currentTime = 1;
  f.audio.advanceEvent(first,500,2000);f.audio.resumeEvent(first);
  assert.equal(f.sources.length,count);
  f.contexts[0].currentTime = 1.3;
  f.audio.advanceEvent(first,500,2000);assert.ok(f.sources.length > count);
  f.audio.stopEvent(first);
  assert.equal(f.audio.events.has(first),false);
  const stopped = f.sources.length;
  f.audio.advanceEvent(first,1000,2000);assert.equal(f.sources.length,stopped);
  f.audio.silence();assert.equal(f.audio.voices.size,0);assert.equal(f.audio.events.has(second),true);
  f.audio.stopAll();assert.equal(f.audio.events.size,0);
});

test('large progress jumps emit one beat, fast frames are capped, and hidden tabs retain progress without queued sounds', async () => {
  const f = fixture(), owner = {};
  await f.unlock();
  f.audio.startEvent(owner,{type:'walk',path:Array(20).fill({x:1,y:1})},{duration:5000});
  f.contexts[0].currentTime = 1;
  const before = f.sources.length;
  f.audio.advanceEvent(owner,4000,5000);
  assert.equal(f.sources.length - before,2); // One footstep: thump plus quiet rustle.
  f.audio.advanceEvent(owner,4500,5000);assert.equal(f.sources.length - before,2);
  f.document.visibilityState = 'hidden';f.listeners.get('visibilitychange')();
  assert.equal(f.audio.voices.size,0);assert.equal(f.audio.events.size,1);
  f.audio.result(true);assert.equal(f.sources.length - before,2);
  f.contexts[0].currentTime = 2;
  f.audio.advanceEvent(owner,4600,5000);
  f.document.visibilityState = 'visible';f.audio.advanceEvent(owner,4600,5000);
  assert.equal(f.sources.length - before,2);
  f.audio.advanceEvent(owner,4900,5000);assert.equal(f.sources.length - before,4);
});

test('delivery walks use a repeatable quiet rolling cue and browserless import avoids preference access', async () => {
  const f = fixture(), owner = {};
  await f.unlock();
  f.audio.startEvent(owner,{type:'walk',chapterId:4},{duration:2000});
  assert.equal(f.audio.events.get(owner).kind,'cycle');
  assert.equal(f.audio.events.get(owner).repeat,true);
  const before = f.sources.length;
  f.contexts[0].currentTime = 1;f.audio.advanceEvent(owner,500,2000);
  assert.equal(f.sources.length-before,2);
  let reads = 0;
  new GameAudio({get localStorage(){reads++;throw new Error('browser only');}});
  assert.equal(reads,0);
});

test('missing Web Audio and denied storage degrade to a safe functioning toggle', () => {
  const audio = new GameAudio({get localStorage(){throw new Error('denied');}});
  assert.equal(audio.supported,false);
  const attributes = {}, handlers = {};
  const button = {addEventListener:(name,fn)=>{handlers[name]=fn;},setAttribute:(key,value)=>{attributes[key]=value;}};
  audio.bindButton(button);assert.equal(button.textContent,'音效：开');assert.equal(attributes['aria-pressed'],'true');
  assert.doesNotThrow(() => {
    handlers.click({isTrusted:true});audio.unlock({isTrusted:true});audio.step();audio.result(false);
    audio.startEvent('owner',{type:'action',actionId:'water'});audio.advanceEvent('owner',400,1000);
    audio.pauseEvent('owner');audio.resumeEvent('owner');audio.stopEvent('owner');audio.stopAll();
  });
  assert.equal(button.textContent,'音效：关');assert.equal(attributes['aria-pressed'],'false');
});

test('source creation errors are contained and ended nodes disconnect', async () => {
  const f = fixture();await f.unlock();f.audio.result(true);
  const active = [...f.audio.voices];assert.equal(active.length,2);
  active[0].source.onended();assert.equal(f.audio.voices.size,1);assert.ok(active[0].nodes.every(node=>node.disconnected));
  f.contexts[0].createOscillator = () => {throw new Error('device lost');};
  assert.doesNotThrow(() => f.audio.result(false));assert.equal(f.audio.voices.size,0);
});
