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
const initialQueue=waiting(s);
const planned=planMatches(s,2,now+20);
assert.equal(planned.length,2);
assert.equal(new Set(planned.flatMap(p=>p.teams.flat())).size,8);
assert(planned.flatMap(p=>p.teams.flat()).every(id=>initialQueue.slice(0,8).some(player=>player.id===id)),
  'With 16 waiting players, automatic selection must stay within the top eight');

// At eight or fewer, the full queue remains eligible.
let eight=applyAction(emptySession(now),{type:'queueSettings',queueMode:'atr'},now);
eight=applyAction(eight,{type:'addPlayers',names:Array.from({length:8},(_,i)=>'Eight '+i)},now+1);
assert.equal(planMatches(eight,2,now+2).length,2);

// Odd queue sizes round the top half up. A linked pair crossing that boundary
// must be excluded together, leaving the four unlinked players eligible.
let boundary=applyAction(emptySession(now),{type:'queueSettings',queueMode:'atr'},now);
boundary=applyAction(boundary,{type:'addPlayers',names:Array.from({length:10},(_,i)=>'Boundary '+i)},now+1);
boundary.players.forEach((player,index)=>{player.waitSince=now+index;player.joinedAt=now+index;});
const boundaryQueue=waiting(boundary);
assert.equal(boundaryQueue.length,10);
boundary=applyAction(boundary,{type:'linkPartners',playerId:boundaryQueue[4].id,partnerId:boundaryQueue[5].id},now+20);
const boundaryPlans=planMatches(boundary,2,now+21);
assert.equal(boundaryPlans.length,1);
assert.deepEqual(new Set(boundaryPlans[0].teams.flat()),new Set(boundaryQueue.slice(0,4).map(player=>player.id)));

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

let requested=demoSession(now);
const selected=waiting(requested).slice(-4).map(player=>player.id);
requested=applyAction(requested,{type:'createRequestedMatch',playerIds:selected},now+1);
assert.equal(requested.requestedMatch.gamesRemaining,5,'12 players ahead plus two active courts should require five completed games');
assert.equal(waiting(requested).length,12,'Requested players must leave the regular waiting queue');
assert.deepEqual(requested.requestedMatch.teams.flat(),selected);
requested=applyAction(requested,{type:'end',courtId:'c1',winner:'A'},now+2);
assert.equal(requested.requestedMatch.gamesRemaining,4,'Every completed game decrements the requested-match countdown');
requested=applyAction(requested,{type:'cancelRequestedMatch'},now+3);
assert.equal(requested.requestedMatch,undefined);
assert.equal(waiting(requested).length,16,'Cancelling returns all four players to the queue');
assert(selected.every(id=>requested.players.find(player=>player.id===id).queueAhead?.length===12),
  'Cancelled requested-match players must rejoin behind everyone who was already waiting');

let readyRequested=demoSession(now);
const readyIds=waiting(readyRequested).slice(-4).map(player=>player.id);
readyRequested=applyAction(readyRequested,{type:'createRequestedMatch',playerIds:readyIds},now+1);
readyRequested=applyAction(readyRequested,{type:'end',courtId:'c1',winner:'A'},now+2);
readyRequested.requestedMatch.gamesRemaining=0;
readyRequested=applyAction(readyRequested,{type:'fill',courtId:'c1'},now+3);
assert.equal(readyRequested.requestedMatch,undefined,'Starting a ready requested match clears its pending record');
assert.deepEqual(readyRequested.courts.find(court=>court.id==='c1').match.teams.flat(),readyIds,
  'A ready requested match takes priority on the next open court');
assert(readyIds.every(id=>readyRequested.players.find(player=>player.id===id).status==='playing'));
console.log('Requested-match countdown, queue exclusion, cancellation and court priority passed.');
