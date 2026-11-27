import assert from 'node:assert/strict';
import {applyAction,emptySession} from '../lib/engine.ts';
import {QUEUE_MODES,sessionResults} from '../lib/queue-modes.ts';

const now=1800000000000;
assert.deepEqual(QUEUE_MODES.map(([key])=>key),['atr']);
const session=emptySession(now);
for(const retired of ['atrResults','balanced','social','skill','results','skillCourts','mixed','ladder','clubs']){
  assert.throws(()=>applyAction(session,{type:'queueSettings',queueMode:retired},now),/ATR is the only matching mode/);
}
assert.equal(typeof sessionResults(session).standings,'object');
console.log('Only ATR is exposed and accepted as a matching mode.');
