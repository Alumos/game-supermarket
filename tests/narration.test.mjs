import test from 'node:test';
import assert from 'node:assert/strict';
import {TASKS,actionLabel,exampleGraph,simulate} from '../shared/engine.mjs';
import {SupermarketWorld} from '../public/world.js';

const world=Object.create(SupermarketWorld.prototype);
const indoor=TASKS.filter(task=>task.chapterId<4);

test('every simulated indoor production event uses the operation card wording on the map',()=>{
  for(const task of indoor){
    const result=simulate(exampleGraph(task.chapterId,task.id));
    assert.equal(result.completed,true,task.id);
    const operations=result.trace.flatMap(step=>step.events).filter(event=>event.type==='action');
    if(task.id==='drink-swap'){
      const handling=result.trace.flatMap(step=>step.events).filter(event=>['take','place'].includes(event.type));
      assert.equal(handling.length,6);
      for(const event of handling){
        const text=world._actionText(event);
        assert.match(text,event.type==='take'?/拿起/:/放下/);
        assert.equal(event.state.holding,event.type==='take'?event.item:null,'narration follows the physical crate event');
      }
    }else{
      assert.deepEqual(operations.map(event=>event.actionId),task.actions.map(action=>action.actionId));
      for(const event of operations)assert.equal(world._actionText(event),actionLabel(event),`${task.id}/${event.actionId}`);
    }
  }
});

test('tea narration follows the actual cup, water, waiting, removal and lid states',()=>{
  const result=simulate(exampleGraph(3,'tea'));
  const events=result.trace.flatMap(step=>step.events).filter(event=>event.type==='action');
  const sequence=[['cup','取杯放茶包'],['water','注入规定量适温水'],['steep','等待浸泡（快进）'],['remove_bag','取出茶包'],['lid','加盖贴签']];
  assert.deepEqual(events.map(event=>[event.actionId,world._actionText(event)]),sequence);
  for(const [index,event] of events.entries()){
    assert.deepEqual(Object.keys(event.state.flags).filter(key=>event.state.flags[key]),sequence.slice(0,index+1).map(([id])=>id),'future operations must not be described as completed');
  }
  assert.equal(events[2].duration,3,'waiting is an actual simulated phase');
  assert.doesNotMatch(world._actionText(events[2]),/放入茶包|加盖|取出/);
});
