import assert from 'node:assert/strict';
import {emptySession,applyAction,demoSession,waiting,planMatches,upcomingPlans,CAP} from '../lib/engine.ts';
import {globalStandings} from '../lib/global-standings.ts';
import {QUEUE_MODES,sessionResults} from '../lib/queue-modes.ts';

const now=1800000000000;
assert.deepEqual(QUEUE_MODES.map(([key])=>key),['atr']);
let s=applyAction(emptySession(now),{type:'queueSettings',queueMode:'atr',selfCheckin:true},now);
assert.equal(s.queueMode,'atr');
assert.equal('fifo' in s,false);
assert.throws(()=>applyAction(s,{type:'queueSettings',queueMode:'social'},now),/ATR is the only matching mode/);
assert.throws(()=>applyAction(s,{type:'queueSettings',queueMode:'atr',fifo:true},now),/FIFO is no longer/);

for(let i=0;i<16;i++)s=applyAction(s,{type:'selfCheckin',name:'ATR '+i,checkInKey:crypto.randomUUID()},now+i);
assert(s.players.every(p=>p.skill===''&&!p.side));
const planned=planMatches(s,2,now+20);
assert.equal(planned.length,2);
assert.equal(new Set(planned.flatMap(p=>p.teams.flat())).size,8);
const rerated=structuredClone(s);
rerated.players.forEach((p,i)=>{p.skill=i%2?'5.5':'1.0';p.side=i%2?'A':'B';});
assert.deepEqual(planMatches(rerated,2,now+20),planned);

let maxMissed=0;
for(let round=0;round<24;round++){
  s=applyAction(s,{type:'simulate'},now+(round+1)*CAP);
  maxMissed=Math.max(maxMissed,...waiting(s).map(p=>p.missed));
}
assert(maxMissed<=3);
const met=s.players.map(a=>s.players.filter(b=>a.id!==b.id&&(s.partners[[a.id,b.id].sort().join('|')]||s.opponents[[a.id,b.id].sort().join('|')])).length);
assert(Math.min(...met)>=12);
s=applyAction(s,{type:'end',courtId:'c1',winner:'A'},now+26*CAP);
const results=sessionResults(s).standings;
assert(results.length);
assert(results.every(row=>row.games===s.players.find(p=>p.id===row.id).games));
assert.equal(globalStandings([s]).reduce((sum,row)=>sum+row.wins,0)>=2,true);
const cleared=applyAction(s,{type:'clear'},now+27*CAP);
assert.equal(cleared.queueMode,'atr');
assert.equal('fifo' in cleared,false);
console.log('ATR-only settings, queue fairness, matchup variety, winner recording and standings passed.',{maxMissed,minPlayersMet:Math.min(...met)});

for(const count of [20,24]){
  let session={...demoSession(now),queueMode:'atr'};
  session.players=session.players.slice(0,count);
  session=applyAction(session,{type:'endAll'},now+CAP);
  const next=upcomingPlans(session);
  assert(next.length>0);
  session=applyAction(session,{type:'fill'},now+CAP+1);
  assert(session.courts.some(court=>court.match));
}
console.log('ATR large-session rotation and sit-out planning passed.');
