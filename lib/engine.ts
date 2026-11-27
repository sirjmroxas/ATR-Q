import type {StandingsCutoffs,StandingsSnapshot} from './global-standings';
import {validateRating, validateHeadshot} from './player-profile.ts';
import { DEFAULT_SLOGAN, QUEUE_MODES, clubNames, clubLineupIsValid, formatCost, isAtrMode, ladderTargets, sessionResults, type QueueMode } from './queue-modes.ts';
export type Player = {id:string;name:string;skill:string;status:'waiting'|'playing'|'paused'|'checkedOut';games:number;queueAhead?:string[];eligibleAfterStart?:number;credit?:number;partnerId?:string;photo?:string;checkInKey?:string;division?:'men'|'women';side?:'A'|'B';waitSince:number;missed:number;joinedAt:number};
type DoublesTeams = [string[], string[]];
export type Match = {recordedPairs?:string[];teams:[string[],string[]];startedAt:number;pausedAt:number|null;pausedMs:number;id:string};
export type Court = {id:string;name:string;match:Match|null};
export type Plan = {teams:[string[],string[]];penalty:number;courtId?:string;manual?:boolean;resultFallback?:boolean;entryQueueVersion?:1};
export type Session = {id:string;title:string;club:string;slogan?:string;globalArchives?:StandingsSnapshot[];globalStandingsRoot?:string;globalStandingsCutoffs?:StandingsCutoffs;queueMode?:QueueMode;clubs?:{A:string;B:string};showStandings?:boolean;selfCheckin?:boolean;hardCap?:boolean;capacityLimit?:boolean;nextOverrides?:Record<string,DoublesTeams>;sharedNext?:Plan[];gameStarts?:number;primary:string;accent:string;logo:string;createdAt:number;endedAt?:number;players:Player[];courts:Court[];partners:Record<string,number>;opponents:Record<string,number>;history:{id:string;court:string;courtId?:string;teams:string[][];names:string[][];endedAt:number;duration:number;score:string;reason:string;winner?:0|1}[];round:number;rotationProgress:number;rotationSelections:string[];seed:number;standardRules:boolean;revision:number;updatedAt:number};
export const CAP_MINUTES = 13;
export const CAP_PLAYER_THRESHOLD = 22;
export const CAP = CAP_MINUTES * 60_000;
const CAP_REASON = `${CAP_MINUTES}-minute cap`;
export const pairKey=(a:string,b:string)=>[a,b].sort().join('|');
export const activePlayers=(s:Session)=>s.players.filter(p=>p.status==='waiting'||p.status==='playing');
const ATR_SIT_OUT_GAMES = 3;
const usesAtrSitOut = (s: Session) =>
  s.queueMode === 'atr' && s.courts.length === 2 && activePlayers(s).length >= 20;

export const fastRules=(s:Session)=>activePlayers(s).length/s.courts.length>=9;
export const effectiveFast=(s:Session)=>fastRules(s)||!s.standardRules;
export const rotationGames=(p:Player)=>p.games+(p.credit||0);
const usesQueueOrder = (_session: Session) => true;
function compareQueuePriority(a: Player, b: Player, byQueue = false) {
  return (byQueue ? 0 : rotationGames(a) - rotationGames(b)) || a.waitSince - b.waitSince || a.joinedAt - b.joinedAt || (byQueue ? 0 : a.id.localeCompare(b.id));
}

function queuePriorities(players: Player[], byQueue = false) {
  const byId = new Map(players.map(player => [player.id, player]));
  return new Map(players.map(player => {
    const partner = player.partnerId ? byId.get(player.partnerId) : undefined;
    return [player.id, partner && compareQueuePriority(player, partner, byQueue) < 0 ? partner : player] as const;
  }));
}

export function waiting(session: Session) {
  const queue = session.players.filter(player => player.status === 'waiting');
  const byQueue = usesQueueOrder(session);
  const priority = queuePriorities(queue, byQueue);
  const held = (player: Player) => Number(!!player.partnerId && !priority.has(player.partnerId));
  return queue.sort((a, b) => held(a) - held(b) ||
    compareQueuePriority(priority.get(a.id)!, priority.get(b.id)!, byQueue) || compareQueuePriority(a, b, byQueue));
}
const meetsCapThreshold = (session: Session) => activePlayers(session).length >= CAP_PLAYER_THRESHOLD;
export const hardCapEnabled = (session: Session) => session.hardCap ?? meetsCapThreshold(session);
export const elapsed = (match: Match, now = Date.now()) => Math.max(0, (match.pausedAt ?? now) - match.startedAt - match.pausedMs);
export const remaining = (match: Match, now = Date.now()) => Math.max(0, CAP - elapsed(match, now));
const capReached = (session: Session, match: Match, now: number) => hardCapEnabled(session) && remaining(match, now) === 0;
export function uniqueMet(s:Session,id:string){return s.players.filter(p=>p.id!==id&&(s.partners[pairKey(id,p.id)]||s.opponents[pairKey(id,p.id)])).length;}
const clone=<T,>(s:T):T=>JSON.parse(JSON.stringify(s));
function hash(str:string){let h=2166136261;for(let i=0;i<str.length;i++)h=Math.imul(h^str.charCodeAt(i),16777619);return (h>>>0)/4294967296;}
function record(s:Session,teams:string[][],only?:string){
  for(const team of teams){if(!only||team.includes(only)){const key=pairKey(team[0],team[1]);s.partners[key]=(s.partners[key]||0)+1;}}
  for(const a of teams[0])for(const b of teams[1])if(!only||a===only||b===only){const key=pairKey(a,b);s.opponents[key]=(s.opponents[key]||0)+1;}
}
function teamPenalty(s:Session,t:string[][],linked?:Map<string,string>){let n=0;for(const team of t)if(linked?.get(team[0])!==team[1])n+=100*(s.partners[pairKey(team[0],team[1])]||0);for(const a of t[0])for(const b of t[1])n+=35*(s.opponents[pairKey(a,b)]||0);return n;}
function socialMixCost(session: Session, teams: DoublesTeams, linked: Map<string,string>) {
  let cost = 0;
  for (const [first, second] of teams) {
    if (linked.get(first) !== second) cost += 1000 * (session.partners[pairKey(first, second)] ?? 0);
  }
  for (const first of teams[0]) for (const second of teams[1]) {
    cost += 200 * (session.opponents[pairKey(first, second)] ?? 0);
  }
  return cost - countFirstMeetings(session, teams.flat()) * 400;
}

// A first meeting counts whether players share a team or face each other.
function countFirstMeetings(session: Session, ids: string[]) {
  let count = 0;
  for (let first = 0; first < ids.length; first++) for (let second = first + 1; second < ids.length; second++) {
    const pair = pairKey(ids[first], ids[second]);
    if (!session.partners[pair] && !session.opponents[pair]) count++;
  }
  return count;
}

function entryQueueBlockers(session: Session, queue: Player[]) {
  if (session.queueMode !== 'atr') return new Map<string, string[]>();
  const waitingIds = new Set(queue.map(player => player.id));
  return new Map(queue.map(player => {
    // Older saved sessions have no entry snapshot. A player still waiting since
    // before this check-in has not had a turn since the newcomer joined.
    const ahead = player.queueAhead ?? (player.games === 0
      ? queue.filter(other => other.id !== player.id && other.waitSince < player.joinedAt).map(other => other.id)
      : []);
    return [player.id, ahead.filter(id => waitingIds.has(id))];
  }));
}

function releaseEntryQueue(session: Session, ids: string[]) {
  const served = new Set(ids);
  for (const player of session.players) {
    if (player.queueAhead) player.queueAhead = player.queueAhead.filter(id => !served.has(id));
  }
}

function planAutomatic(s:Session,count:number,now:number,courtIds:string[]):Plan[]{
  const allWaiting = waiting(s);
  const byId = new Map(allWaiting.map(player => [player.id, player]));
  const queue = allWaiting.filter(player => !player.partnerId || byId.has(player.partnerId));
  count=Math.min(count,2,Math.floor(queue.length/4));if(!count)return [];
  const linked = playerLinks(queue);
  const entryBlockers = entryQueueBlockers(s, queue);
  const byQueue = usesQueueOrder(s);
  const priorities = queuePriorities(queue, byQueue);
  const priorityOf = (player: Player) => priorities.get(player.id)!;
  const mode=s.queueMode??'atr';
  const strict=['skill','skillCourts','mixed','clubs','results'].includes(mode);
  const resultMode = mode==='results'||mode==='atrResults';
  const sitOut = usesAtrSitOut(s);
  const gameStarts = s.gameStarts ?? 0;
  const latest=resultMode?sessionResults(s).latest:new Map<string,'win'|'loss'>();
  const ladder = mode === 'ladder' ? ladderTargets(s) : undefined;
  const targets=strict?courtIds:courtIds.slice(0,count);
  const ordered=queue;
  // Search the waiting pool for fresh groups, keeping linked pairs together.
  const pool = mode === 'clubs'
    ? [...candidatePool(ordered.filter(player => player.side === 'A'), 12),
       ...candidatePool(ordered.filter(player => player.side === 'B'), 12)]
    : candidatePool(ordered,24);
  const waitPriority = (player:Player) => {
    const priority=priorityOf(player);
    return Math.max(0,now-priority.waitSince)/60000 + priority.missed*15;
  };
  const largestWait=Math.max(1,...pool.map(waitPriority));
  // This bound makes a mixed result group more expensive than every possible
  // social-mix difference across this batch, regardless of session length.
  const partnerMax=Math.max(0,...Object.values(s.partners));
  const opponentMax=Math.max(0,...Object.values(s.opponents));
  const socialCostBound=(2000*partnerMax+800*opponentMax+4800)*count;
  const firstMeetingWeight=socialCostBound+1;
  const overdueCost=mode==='atr' ? firstMeetingWeight*(6*count+1) : socialCostBound+1;
  const freshTeammateCost=overdueCost*(count*4+1);
  const urgentCost=freshTeammateCost*(count*2+1);
  const mixedResultCost=urgentCost*(count*4+1);
  // Keep courts occupied while minimizing immediate replays across the full batch.
  const rematchCost=(urgentCost+overdueCost)*(count*4)+overdueCost;
  // Prefer a fully eligible group for the first start, then the second.
  // When a court would otherwise be empty, use as few cooling-down players as possible.
  const sitOutCost = (count + 1) * rematchCost;
  const lastGame=new Map<string,string>();
  for(const game of s.history)for(const id of game.teams.flat())if(!lastGame.has(id))lastGame.set(id,game.id);
  const immediateRematch=(teams:DoublesTeams)=>{
    const ids=teams.flat(),game=lastGame.get(ids[0]);
    return !!game&&ids.every(id=>lastGame.get(id)===game);
  };
  type Group = Plan & {mask:number;cost:number;entryBlockers:string[]};
  const options: Group[][] = targets.map(() => []);
  for(let a=0;a<pool.length-3;a++)for(let b=a+1;b<pool.length-2;b++)for(let c=b+1;c<pool.length-1;c++)for(let d=c+1;d<pool.length;d++){
    const ps=[pool[a],pool[b],pool[c],pool[d]], ids=ps.map(p=>p.id);
    const missingAhead = [...new Set(ids.flatMap(id => entryBlockers.get(id) ?? []))]
      .filter(id => !ids.includes(id));
    const firstMeetings = mode === 'atr' ? countFirstMeetings(s, ids) : 0;
    const splits=[[0,1,2,3],[0,2,1,3],[0,3,1,2]].flatMap(order=>{
      const ordered=order.map(i=>ps[i]);
      const teams:[string[],string[]]=[order.slice(0,2).map(i=>ids[i]),order.slice(2).map(i=>ids[i])];
      if (!keepsLinkedPartners(teams, linked)) return [];
      const mix=socialMixCost(s,teams,linked);
      const penalty=mode==='atr'?mix:teamPenalty(s,teams,linked);
      return {ordered,teams,penalty,cost:mix+hash(teams.flat().join(',')+s.seed)*.000001};
    });
    // Waiting only breaks social-mix ties. Across two courts this bonus is
    // always below one point, while social-mix differences are whole points.
    const priority=ps.reduce((total,player)=>total+waitPriority(player)/largestWait,0)/32;
    const overdue=mode==='atr' ? 0 : ps.filter(player=>lastGame.has(player.id)&&priorityOf(player).missed>=2).length*overdueCost;
    const urgent=ps.filter(player=>(mode==='atr'||lastGame.has(player.id))&&priorityOf(player).missed>=3).length*urgentCost;
    const atrMixAdjustment=mode==='atr'
      ? (immediateRematch([ids.slice(0,2),ids.slice(2)]) ? rematchCost : 0)-firstMeetings*firstMeetingWeight
      : 0;
    targets.forEach((courtId,i)=>{
      // A newcomer's first game follows everyone already waiting. The second
      // group may follow people selected in the first group of this same batch.
      if (missingAhead.length && (i === 0 || missingAhead.length > 4)) return;
      const earlyReturns = sitOut
        ? ps.filter(player => (player.eligibleAfterStart ?? 0) > gameStarts + i).length
        : 0;
      const sitOutPenalty = earlyReturns * sitOutCost * (i === 0 ? 5 : 1);
      let best:Group|undefined;
      for(const split of splits){
        const courtIndex = s.courts.findIndex(c => c.id === courtId);
        const group = (courtIndex + (mode === 'results' ? s.round % 2 : 0)) % 2;
        let extra = formatCost(mode, split.ordered, mode === 'ladder' ? courtIndex : group, latest, ladder);
        if(resultMode && extra===100000)extra=mixedResultCost;
        const repeatedTeammates=resultMode?split.teams.filter(([a,b])=>linked.get(a)!==b&&(s.partners[pairKey(a,b)]??0)>0).length:0;
        const cost=split.cost+extra+repeatedTeammates*freshTeammateCost-priority-overdue-urgent+atrMixAdjustment+sitOutPenalty;
        if(Number.isFinite(cost)&&(!best||cost<best.cost)){
          best={teams:split.teams,penalty:split.penalty,courtId,cost,mask:(1<<a)|(1<<b)|(1<<c)|(1<<d),entryBlockers:missingAhead};
        }
      }
      if(best)options[i].push(best);
    });
  }
  options.forEach((groups,index)=>{
    // A four-player replay is only an option when this court has no fresh
    // eligible alternative. Linked partners and format restrictions still apply.
    const fresh=mode==='atr' ? groups : groups.filter(group=>!immediateRematch(group.teams));
    options[index]=(fresh.length?fresh:groups).sort((a,b)=>a.cost-b.cost);
  });
  const single = sitOut ? options[0][0]
    : options.flatMap(groups=>groups.find(group => !group.entryBlockers.length)??[]).sort((a,b)=>a.cost-b.cost)[0];
  let bestPair:Group[]=[], bestCost=Infinity;
  if(count===2&&options.length===2&&options[1].length){
    for(const first of options[0]){
      if(first.cost+options[1][0].cost>=bestCost)break;
      for(const second of options[1]){
        if(first.cost+second.cost>=bestCost)break;
        if(first.mask&second.mask)continue;
        if(second.entryBlockers.some(id => !first.teams.flat().includes(id)))continue;
        bestPair=[first,second];
        bestCost=first.cost+second.cost;
        break;
      }
    }
  }
  return (bestPair.length?bestPair:single?[single]:[]).map(({teams,penalty,courtId})=>({
    teams,penalty,courtId,
    ...(mode === 'atr' ? {entryQueueVersion: 1 as const} : {}),
    ...(resultMode?{resultFallback:teams.flat().some(id=>latest.get(id)==='win')&&teams.flat().some(id=>latest.get(id)==='loss')}:{}),
  }));
}

function candidatePool(players: Player[], limit: number) {
  const available = new Set(players.map(player => player.id));
  const selected = new Set<string>();
  for (const {id, partnerId} of players) {
    if (selected.has(id)) continue;
    if (partnerId) {
      if (!available.has(partnerId) || selected.size + 2 > limit) continue;
      selected.add(partnerId);
    } else if (selected.size === limit) break;
    selected.add(id);
  }
  return players.filter(player => selected.has(player.id));
}

function playerLinks(players: Player[]) {
  const links = new Map<string, string>();
  for (const { id, partnerId } of players) if (partnerId) links.set(id, partnerId);
  return links;
}

function keepsLinkedPartners(teams: DoublesTeams, links: Map<string, string>) {
  return teams.every(([first, second]) =>
    (links.get(first) ?? second) === second && (links.get(second) ?? first) === first);
}

function assertLinkedLineup(session: Session, teams: DoublesTeams) {
  if (!keepsLinkedPartners(teams, playerLinks(session.players))) {
    throw Error('Put linked teammates on the same team or unlink them in Players & queue.');
  }
}

function unlinkPartner(session: Session, player: Player) {
  const partner = session.players.find(item => item.id === player.partnerId);
  if (partner?.partnerId === player.id) delete partner.partnerId;
  delete player.partnerId;
}

function followsClubRules(session: Session, teams: DoublesTeams) {
  if (session.queueMode !== 'clubs') return true;
  const players = new Map(session.players.map(player => [player.id, player.side]));
  return clubLineupIsValid(teams.flat().map(id => players.get(id)));
}

export function manualPlans(session: Session): Plan[] {
  const waitingIds = new Set(waiting(session).map(player => player.id));
  const linked = playerLinks(session.players);
  return session.courts.flatMap(court => {
    const teams = session.nextOverrides?.[court.id];
    if (!teams || !teams.flat().every(id => waitingIds.has(id)) || !followsClubRules(session, teams) || !keepsLinkedPartners(teams, linked)) return [];
    return [{ courtId: court.id, teams, penalty: teamPenalty(session, teams), manual: true }];
  });
}

export function planMatches(session: Session, count = session.courts.length, now = Date.now(), courtIds = session.courts.map(court => court.id)): Plan[] {
  if (session.endedAt != null) return [];
  const overrides = manualPlans(session);
  const selected = overrides.filter(plan => courtIds.includes(plan.courtId!)).slice(0, count);
  const reserved = new Set(overrides.flatMap(plan => plan.teams.flat()));
  const available: Session = {
    ...session,
    players: session.players.map(player => reserved.has(player.id) ? { ...player, status: 'playing' } : player),
  };
  const openTargets = courtIds.filter(id => !selected.some(plan => plan.courtId === id));
  const automatic: Plan[] = [];
  // Pair adjacent courts for the existing optimizer and carry assignments forward.
  for (let start = 0; start < openTargets.length && selected.length + automatic.length < count; start += 2) {
    const batch = openTargets.slice(start, start + 2);
    const plans = planAutomatic(available, Math.min(batch.length, count - selected.length - automatic.length), now, batch);
    automatic.push(...plans);
    const assigned = new Set(plans.flatMap(plan => plan.teams.flat()));
    available.players = available.players.map(player => assigned.has(player.id) ? { ...player, status: 'playing' } : player);
  }
  return [...selected, ...automatic]
    .sort((a, b) => courtIds.indexOf(a.courtId!) - courtIds.indexOf(b.courtId!));
}

export const usesSharedNext = (session: Session) =>
  session.queueMode !== 'skillCourts' && session.queueMode !== 'ladder';

function sharedUpcomingPlans(session: Session): Plan[] {
  const manual = manualPlans(session);
  const queue = waiting(session);
  const ranks = new Map(queue.map((player, index) => [player.id, index]));
  const reserved = new Set(manual.flatMap(plan => plan.teams.flat()));
  const availableCourts = session.courts.filter(court => !manual.some(plan => plan.courtId === court.id));
  const sitOut = usesAtrSitOut(session);
  const gameStarts = session.gameStarts ?? 0;
  const eligibleAfterStart = new Map(queue.map(player => [player.id, player.eligibleAfterStart ?? 0]));
  const held = (session.sharedNext ?? []).filter(plan =>
    (session.queueMode !== 'atr' || plan.entryQueueVersion === 1) &&
    plan.teams.flat().every(id => ranks.has(id) && !reserved.has(id))
  ).slice(0, availableCourts.length);
  // Keep announced groups in order unless a planned early return needs rechecking.
  const firstEarlyReturn = sitOut ? held.findIndex((plan, index) =>
    plan.teams.flat().some(id => eligibleAfterStart.get(id)! > gameStarts + index)
  ) : -1;
  if (firstEarlyReturn !== -1) held.length = firstEarlyReturn;
  const entryBlockers = entryQueueBlockers(session, queue);
  const served = new Set<string>();
  const firstQueueJump = held.findIndex(plan => {
    const ids = plan.teams.flat();
    const jumpsQueue = ids.some(id => (entryBlockers.get(id) ?? []).some(ahead =>
      !served.has(ahead) && !ids.includes(ahead)));
    ids.forEach(id => served.add(id));
    return jumpsQueue;
  });
  if (firstQueueJump !== -1) held.length = firstQueueJump;
  for (const plan of held) for (const id of plan.teams.flat()) reserved.add(id);
  const remainingCourts = availableCourts.slice(held.length);
  const available: Session = {
    ...session,
    nextOverrides: undefined,
    gameStarts: gameStarts + held.length,
    players: session.players.map(player => reserved.has(player.id) ? { ...player, status: 'playing' } : player),
  };
  const firstRank = (plan: Plan) => Math.min(...plan.teams.flat().map(id => ranks.get(id)!));
  const automatic = planMatches(available, remainingCourts.length, session.updatedAt, remainingCourts.map(court => court.id))
    .map(plan => ({ ...plan, courtId: undefined }));
  if (!sitOut || automatic.every(plan => plan.teams.flat().every(id =>
    eligibleAfterStart.get(id)! <= gameStarts + held.length
  ))) {
    automatic.sort((a, b) => firstRank(a) - firstRank(b));
  }
  return [...held, ...automatic, ...manual];
}

export function upcomingPlans(session: Session): Plan[] {
  if (session.endedAt != null) return [];
  if (usesSharedNext(session)) return sharedUpcomingPlans(session);
  const open = session.courts.filter(court => !court.match).map(court => court.id);
  const occupied = session.courts.filter(court => court.match).map(court => court.id);
  if (!open.length || !occupied.length) return planMatches(session, session.courts.length, session.updatedAt);
  const first = planMatches(session, open.length, session.updatedAt, open);
  const assigned = new Set(first.flatMap(plan => plan.teams.flat()));
  const remainingPlayers: Session = {
    ...session,
    players: session.players.map(player => assigned.has(player.id) ? { ...player, status: 'playing' } : player),
  };
  return [...first, ...planMatches(remainingPlayers, occupied.length, session.updatedAt, occupied)];
}

export function upcomingReasons(session: Session, plans: Plan[], latest?: Map<string, 'win' | 'loss'>) {
  const mode = session.queueMode ?? 'social';
  const queue = waiting(session);
  const priorities = queuePriorities(queue, usesQueueOrder(session));
  const sitOut = usesAtrSitOut(session);
  const ladder = mode === 'ladder' ? ladderTargets(session) : undefined;
  const results = latest ?? ((mode === 'results' || mode === 'atrResults') ? sessionResults(session).latest : undefined);
  const previouslyPlayed = new Set(session.history.flatMap(game => game.teams.flat()));
  let automaticStarts = session.gameStarts ?? 0;

  return plans.map(plan => {
    if (plan.manual) return 'This lineup was set by the organizer.';

    const ids = plan.teams.flat();
    const players = ids.map(id => queue.find(player => player.id === id)!);
    const starts = automaticStarts++;
    if (sitOut && players.some(player => (player.eligibleAfterStart ?? 0) > starts)) {
      return 'An early return helps fill this court.';
    }

    switch (mode) {
      case 'clubs': {
        const clubs = clubNames(session);
        return `Two players from ${clubs[players[0].side!]} face two from ${clubs[players[2].side!]}.`;
      }
      case 'mixed':
        return 'Each team has one player from each doubles category.';
      case 'skill':
        return 'All four players are within half a rating point.';
      case 'skillCourts':
        return Number(players[0].skill) >= 3.5
          ? 'All four meet this court’s 3.5+ rating requirement.'
          : 'All four meet this court’s below-3.5 rating requirement.';
      case 'ladder': {
        const court = session.courts.findIndex(item => item.id === plan.courtId);
        const assigned = ids.some(id => ladder?.has(id));
        return assigned && ids.some(id => ladder?.get(id) === court)
          ? 'This court matches some players’ ladder positions.'
          : assigned ? 'The ladder uses the available players and their recent results.'
          : 'This is a starting court for players without a recorded ladder result.';
      }
      case 'results':
      case 'atrResults': {
        if (plan.resultFallback) return 'The queue is small, so recent winners and losers are mixed.';
        const outcome = ids.map(id => results?.get(id)).find(Boolean);
        if (outcome) return outcome === 'win'
          ? 'Players with recent wins are grouped together.'
          : 'Players with recent losses are grouped together.';
        return 'This group is ready to play while recent results are being recorded.';
      }
      case 'balanced':
        if (players.every(player => Number.isFinite(Number.parseFloat(player.skill)))) {
          return 'Player ratings were used to balance the two teams.';
        }
        break;
    }

    const waitThreshold = mode === 'atr' ? 3 : 2;
    if (ids.some(id => (mode === 'atr' || previouslyPlayed.has(id)) &&
      (priorities.get(id)?.missed ?? 0) >= waitThreshold)) {
      return 'This group includes players with priority after several rotations.';
    }
    const firstMeetings = countFirstMeetings(session, ids);
    if (firstMeetings) return firstMeetings === 1
      ? 'Two players will share a court for the first time this session.'
      : `This group has ${firstMeetings} first-time encounters as teammates or opponents.`;
    if (sitOut && players.some(player => player.eligibleAfterStart !== undefined)) {
      return 'Some players have completed their three-game sit-out.';
    }
    return 'The rotation looked for fewer repeat partners and opponents among the available players.';
  });
}

export function waitingForLineup(session: Session) {
  const queue = waiting(session);
  if (queue.length < 4) return 'Waiting for four eligible players.';
  const waitingIds = new Set(queue.map(player => player.id));
  const ready = queue.filter(player => !player.partnerId || waitingIds.has(player.partnerId));
  if (ready.length < 4) return 'Waiting for linked teammates to be available together.';
  switch (session.queueMode) {
    case 'clubs': return 'Waiting for two available players from each club.';
    case 'mixed': return 'Waiting for two available players in each doubles category.';
    case 'skill': return 'Waiting for four rated players within half a rating point.';
    case 'skillCourts': return 'Waiting for four eligible players in the same court’s rating group.';
    default: return 'Waiting for four players who can form two eligible teams.';
  }
}

function readLineup(value: unknown): DoublesTeams {
  if (!Array.isArray(value) || value.length !== 4 ||
      value.some(id => typeof id !== 'string' || !id) || new Set(value).size !== 4) {
    throw Error('Choose four different players.');
  }
  return [value.slice(0, 2), value.slice(2)];
}

function removeReservations(session: Session, playerIds: string[]) {
  for (const [courtId, teams] of Object.entries(session.nextOverrides ?? {})) {
    if (teams.flat().some(id => playerIds.includes(id))) delete session.nextOverrides![courtId];
  }
}

function lineupPairs(teams: DoublesTeams) {
  return [
    ...teams.map(([a, b]) => ({ kind: 'partners' as const, pair: pairKey(a, b) })),
    ...teams[0].flatMap(a => teams[1].map(b => ({ kind: 'opponents' as const, pair: pairKey(a, b) }))),
  ].map(pair => ({ ...pair, key: pair.kind + ':' + pair.pair }));
}

function replaceCourtLineup(session: Session, match: Match, teams: DoublesTeams, now: number) {
  const previous = match.teams.flat();
  const next = teams.flat();
  const alreadyRecorded = new Set(match.recordedPairs ?? lineupPairs(match.teams).map(pair => pair.key));
  for (const { key, kind, pair } of lineupPairs(teams)) {
    if (alreadyRecorded.has(key)) continue;
    session[kind][pair] = (session[kind][pair] || 0) + 1;
    alreadyRecorded.add(key);
  }
  match.recordedPairs = [...alreadyRecorded];
  match.teams = teams;
  const replacements = next.filter(id => !previous.includes(id));
  removeReservations(session, replacements);
  releaseEntryQueue(session, replacements);
  session.rotationSelections.push(...replacements);
  for (const player of session.players) {
    if (previous.includes(player.id) && !next.includes(player.id)) {
      player.status = 'waiting';
      player.waitSince = now;
      player.missed = 0;
    }
    if (replacements.includes(player.id)) {
      player.status = 'playing';
      player.missed = 0;
      player.queueAhead = [];
    }
  }
}

export function emptySession(now=Date.now()):Session{return {id:'demo',title:'Evening open play',club:'The Atherton Pickleball Club',slogan:DEFAULT_SLOGAN,queueMode:'atr',showStandings:false,primary:'#0B2E63',accent:'#E8FF4D',logo:'/atherton-crest.png',createdAt:now,players:[],courts:[{id:'c1',name:'Court 1',match:null},{id:'c2',name:'Court 2',match:null}],partners:{},opponents:{},history:[],round:0,rotationProgress:0,rotationSelections:[],seed:1,standardRules:true,revision:0,updatedAt:now};}
export function openCourtForNext(session: Session, plan: Plan, preview: Plan[]) {
  return session.courts.find(court => !court.match && (plan.courtId
    ? court.id === plan.courtId
    : !preview.some(item => item.courtId === court.id)));
}

function fill(s:Session,courtIds:string[],now:number,override?:{index:unknown;lineup:unknown}){
  const courts = s.courts.filter(court => courtIds.includes(court.id) && !court.match);
  let plans: Plan[];
  if (override) {
    const preview = upcomingPlans(s);
    const {index, lineup} = override;
    const selected = index === 0 || index === 1 ? preview[index] : undefined;
    if (!selected || JSON.stringify(selected.teams) !== lineup) {
      throw Error('Up Next has changed. Select the group again.');
    }
    const court = openCourtForNext(s, selected, preview);
    if (!court) throw Error('There is no available court for this group.');
    plans = [{ ...selected, courtId: court.id }];
    if (usesSharedNext(s)) s.sharedNext = preview.filter(plan => plan !== selected && !plan.courtId);
  } else if (usesSharedNext(s)) {
    const preview = upcomingPlans(s);
    const shared = preview.filter(plan => !plan.courtId);
    plans = courts.flatMap(court => {
      const plan = preview.find(item => item.courtId === court.id) ?? shared.shift();
      return plan ? [{ ...plan, courtId: court.id }] : [];
    });
    if (usesAtrSitOut(s)) plans.sort((a, b) => Number(!!a.manual) - Number(!!b.manual));
    s.sharedNext = shared;
  } else {
    plans = planMatches(s, courts.length, now, courts.map(court => court.id));
  }
  if (!plans.length) throw Error('No eligible lineup for the current matching mode and open courts.');
  s.gameStarts = (s.gameStarts ?? 0) + plans.length;
  releaseEntryQueue(s, plans.flatMap(plan => plan.teams.flat()));
  plans.forEach(plan=>{if(s.nextOverrides&&plan.courtId)delete s.nextOverrides[plan.courtId];const ids=plan.teams.flat();s.courts.find(c=>c.id===plan.courtId)!.match={id:crypto.randomUUID(),teams:plan.teams,startedAt:now,pausedAt:null,pausedMs:0};for(const p of s.players)if(ids.includes(p.id)){p.status='playing';p.missed=0;p.queueAhead=[];}record(s,plan.teams);s.rotationSelections.push(...ids);s.rotationProgress++;});
  if(s.rotationProgress>=s.courts.length){s.round++;for(const p of s.players)if(p.status==='waiting'&&!s.rotationSelections.includes(p.id))p.missed++;s.rotationProgress=0;s.rotationSelections=[];}
}
function finish(s:Session,court:Court,now:number,score:string,reason:string,winner?:0|1){
  const m=court.match;if(!m)return;const ids=m.teams.flat();const duration=elapsed(m,now);
  s.history.unshift({id:m.id,court:court.name,courtId:court.id,teams:m.teams,names:m.teams.map(t=>t.map(id=>s.players.find(p=>p.id===id)?.name||'Player')),endedAt:now,duration,score,reason,...(winner!==undefined?{winner}:{})});
  for(const p of s.players)if(ids.includes(p.id)){p.status='waiting';p.games++;p.waitSince=now;p.missed=0;p.eligibleAfterStart=(s.gameStarts??0)+ATR_SIT_OUT_GAMES;}
  court.match=null;
}
const previousDemoNames = ['Sean Edu','Pearl Santos','Miguel Reyes','Alyssa Cruz','Carlo Garcia','Bea Mendoza','James Tan','Nicole Lim','Marco Dela Cruz','Trisha Ramos','Paolo Rivera','Camille Sy','David Santos','Sofia Reyes','Anton Lim','Grace Navarro','Ryan Torres','Patricia Chua','Josh Aquino','Mia Flores','Ken Bautista','Ella Villanueva','Chris Go','Dani Castillo'];
const hollywoodDemoNames = ["Tom Hanks", "Meryl Streep", "Leonardo DiCaprio", "Scarlett Johansson", "Denzel Washington", "Julia Roberts", "Brad Pitt", "Sandra Bullock", "Keanu Reeves", "Anne Hathaway", "Robert Downey Jr.", "Emma Stone", "Will Smith", "Jennifer Lawrence", "Morgan Freeman", "Nicole Kidman", "Matt Damon", "Charlize Theron", "Ryan Reynolds", "Natalie Portman", "George Clooney", "Viola Davis", "Hugh Jackman", "Kate Winslet"];

/** Rename only untouched demo identities, preserving custom players and session state. */
export function migrateDemoNames(session: Session): Session {
  const replacements = new Map<string, string>();
  session.players.forEach(player => {
    const index = previousDemoNames.indexOf(player.name);
    if(index >= 0 && player.id === 'p' + (index + 1)) {
      replacements.set(player.id, hollywoodDemoNames[index]);
    }
  });
  if(!replacements.size)return session;
  const updated = clone(session);
  updated.players.forEach(player => {
    const name = replacements.get(player.id);
    if(name)player.name = name;
  });
  updated.history.forEach(game => {
    game.teams.forEach((team, teamIndex) => {
      team.forEach((id, playerIndex) => {
        const index = previousDemoNames.indexOf(game.names[teamIndex][playerIndex]);
        if(index >= 0 && id === 'p' + (index + 1)) {
          game.names[teamIndex][playerIndex] = hollywoodDemoNames[index];
        }
      });
    });
  });
  return updated;
}
export function demoSession(now=Date.now()):Session{
 const s=emptySession(now-52*60000);const names=hollywoodDemoNames;
 s.players=names.map((name,i)=>({id:'p'+(i+1),name,skill:['3.5','3.0','4.0','3.0'][i%4],division:i%4<2?'men':'women',side:i%2?'B':'A',status:'waiting',games:2,waitSince:now-(i<8?5:i<16?14:7)*60000-(24-i)*1000,missed:i>=8&&i<16?2:1,joinedAt:s.createdAt}));
 // A balanced two-round history seeds realistic mix statistics without inventing results.
 for(let r=0;r<2;r++)for(let j=0;j<6;j++){const ids=Array.from({length:4},(_,k)=>s.players[(j*4+k+r*3)%24].id);record(s,[[ids[0],ids[1]],[ids[2],ids[3]]]);}
 for(let i=0;i<2;i++){const ids=s.players.slice(i*4,i*4+4).map(p=>p.id);const teams:[string[],string[]]=[[ids[0],ids[1]],[ids[2],ids[3]]];s.courts[i].match={id:'demo-match-'+i,teams,startedAt:now-(i===0?6:4)*60000,pausedAt:null,pausedMs:0};ids.forEach(id=>{const p=s.players.find(p=>p.id===id)!;p.status='playing';p.missed=0;});record(s,teams);}
 s.round=3;return s;
}
export type Action={type:string;[key:string]:unknown};
export function applyAction(input:Session,action:Action,now=Date.now()):Session{
 if (input.endedAt != null) {
   if (action.type === 'endSession') return input;
   if (input.id !== 'demo' || action.type !== 'demo') throw Error('This session has ended.');
 }
 let s=clone(migrateDemoNames(input));const str=(k:string)=>String(action[k]??'');const court=s.courts.find(c=>c.id===str('courtId'));
 // Preserve announced groups across court openings. Recalculate after queue or lineup edits.
 if (!['end', 'endAll', 'fill', 'fillNextGroup', 'timer'].includes(action.type)) delete s.sharedNext;
 if ((action.type === 'end' || action.type === 'endAll') && usesSharedNext(s)) {
   s.sharedNext = upcomingPlans(s).filter(plan => !plan.courtId);
 }
 switch(action.type){
 case 'addPlayers':{const side=s.queueMode==='clubs'&&(action.side==='A'||action.side==='B')?action.side:undefined;if(s.queueMode==='clubs'&&!side)throw Error('Choose the players’ club.');const raw=Array.isArray(action.names)?action.names:[];const names=raw.map(n=>String(n).trim()).filter(Boolean);if(!names.length)throw Error('Add at least one player name.');if(s.players.length+names.length>100)throw Error('The session can hold up to 100 checked-in players.');const active=activePlayers(s);if(s.capacityLimit!==false&&active.length+names.length>s.courts.length*12)throw Error('Active capacity is 12 players per court. Add a court or pause players before adding more.');const queueAhead=waiting(s).map(player=>player.id);const baseline=active.length?Math.floor(active.reduce((n,p)=>n+rotationGames(p),0)/active.length):0;for(const name of names){if(name.length>60)throw Error('Player names must be 60 characters or fewer.');s.players.push({id:crypto.randomUUID(),name,skill:str('skill').slice(0,12),side,games:0,queueAhead,credit:baseline,status:'waiting',waitSince:now,joinedAt:now,missed:0});}break;}
 case 'fillNextGroup':fill(s,[],now,{index:action.index,lineup:action.lineup});break;
 case 'fill':fill(s,str('courtId')?[str('courtId')]:s.courts.map(c=>c.id),now);break;
 case 'end':{
 if(!court?.match)throw Error('This court is already open.');
 if(action.matchId!==undefined&&action.matchId!==court.match.id)throw Error('This game has changed. Reopen End game.');
 if(isAtrMode(s.queueMode)){
   if(action.winner!=='A'&&action.winner!=='B'&&action.result!=='unrecorded')throw Error('Choose the winning team or end without a winner.');
   const winner=action.winner==='A'?0:action.winner==='B'?1:undefined;
   finish(s,court,now,winner===undefined?'Not recorded':winner===0?'Team A won':'Team B won',
     capReached(s,court.match,now)?CAP_REASON:'Game completed',winner);
   break;
 }
 const a=str('scoreA'),b=str('scoreB');const timed=capReached(s,court.match,now);if((a&&!b)||(!a&&b))throw Error('Enter both scores, or leave both blank.');if(a&&b){const x=Number(a),y=Number(b);if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>99||y>99)throw Error('Scores must be whole numbers from 0 to 99.');if(!timed&&str('reason')!=='early'){if(x===y||Math.max(x,y)<11)throw Error('A completed game needs a winner with at least 11 points. Use early rotation for an unfinished game.');if(effectiveFast(s)&&(Math.max(x,y)!==11))throw Error('Fast rotation ends at 11. Use early rotation for other scores.');if(!effectiveFast(s)&&Math.abs(x-y)<2)throw Error('Standard rules require a two-point lead.');}}finish(s,court,now,a&&b?a+' – '+b:'Not recorded',timed?CAP_REASON:str('reason')==='early'?'Early rotation':'Game completed');break;}
 case 'endSession': {
   for (const court of s.courts) finish(s, court, now, 'Not recorded', 'Session ended');
   s.endedAt = now;
   s.selfCheckin = false;
   delete s.nextOverrides;
   break;
 }
 case 'endAll':for(const c of s.courts)if(c.match)finish(s,c,now,'Not recorded',capReached(s,c.match,now)?CAP_REASON:'Batch rotation');break;
 case 'timer':{if(!court?.match)throw Error('No active game on this court.');if(hardCapEnabled(s))throw Error(`Timers cannot pause while the ${CAP_MINUTES}-minute hard cap is on.`);const m=court.match;if(m.pausedAt){m.pausedMs+=now-m.pausedAt;m.pausedAt=null;}else m.pausedAt=now;break;}
 case 'pausePlayer':{const p=s.players.find(p=>p.id===str('playerId'));if(!p)throw Error('Player not found.');if(p.status==='playing')throw Error('Swap this player off court before placing them on break.');if(p.status==='paused'){if(s.capacityLimit!==false&&activePlayers(s).length>=s.courts.length*12)throw Error('Active-player capacity is full.');p.status='waiting';p.waitSince=now;p.missed=0;const baseline=Math.floor(activePlayers(s).reduce((n,q)=>n+rotationGames(q),0)/Math.max(1,activePlayers(s).length));p.credit=Math.max(p.credit||0,baseline-p.games);}else if(p.status==='waiting'){p.status='paused';removeReservations(s,[p.id]);releaseEntryQueue(s,[p.id]);}else throw Error('This player is checked out.');break;}
 case 'swap':{if(!court?.match)throw Error('No active game.');const incoming=s.players.find(p=>p.id===str('incomingId')),out=s.players.find(p=>p.id===str('outgoingId'));if(!incoming||incoming.status!=='waiting'||!out||!court.match.teams.flat().includes(out.id))throw Error('Select an on-court player and a waiting replacement.');const teams=court.match.teams.map(t=>t.map(id=>id===out.id?incoming.id:id)) as [string[],string[]];
 const mode=s.queueMode??'atr';
 const participants=teams.flat().map(id=>s.players.find(p=>p.id===id)!);
 const latest=mode==='results'||mode==='atrResults'?sessionResults(s).latest:new Map<string,'win'|'loss'>();
 if(!Number.isFinite(formatCost(mode,participants,s.courts.indexOf(court),latest)))throw Error('That swap does not fit the selected matching mode.');
 assertLinkedLineup(s,teams);
 replaceCourtLineup(s,court.match,teams,now);break;}
 case 'addCourt': {
   if (s.courts.length >= 8) throw Error('A session can have up to eight courts.');
   let number = 1;
   while (s.courts.some(c => c.name === 'Court ' + number)) number++;
   s.courts.push({ id: crypto.randomUUID(), name: 'Court ' + number, match: null });
   break;
 }
 case 'removeCourt': {
   if (!court || court.match) throw Error('End the game before removing this court.');
   if (s.courts.length <= 1) throw Error('Keep at least one court.');
   if (s.capacityLimit !== false && activePlayers(s).length > (s.courts.length - 1) * 12) throw Error('Check out players or put them on break before reducing court capacity.');
   s.courts = s.courts.filter(c => c.id !== court.id);
   if (s.nextOverrides) delete s.nextOverrides[court.id];
   if (s.rotationProgress >= s.courts.length) {
     s.round++;
     for (const player of waiting(s)) if (!s.rotationSelections.includes(player.id)) player.missed++;
     s.rotationProgress = 0;
     s.rotationSelections = [];
   }
   break;
 }
 case 'courtLineup': {
   if (!court?.match || court.match.id !== str('matchId')) throw Error('This game has changed. Reopen the lineup editor.');
   const teams = readLineup(action.playerIds);
   const eligible = new Set([...court.match.teams.flat(), ...waiting(s).map(player => player.id)]);
   if (!teams.flat().every(id => eligible.has(id))) throw Error('Choose players from this court or the waiting queue.');
   if (!followsClubRules(s, teams)) throw Error('Club Wars requires two teammates from each club.');
   assertLinkedLineup(s, teams);
   replaceCourtLineup(s, court.match, teams, now);
   break;
 }
 case 'nextLineup': {
   if (!court) throw Error('Court not found.');
   const teams = readLineup(action.playerIds);
   const eligible = new Set(waiting(s).map(player => player.id));
   if (!teams.flat().every(id => eligible.has(id))) throw Error('Only waiting players can be assigned next.');
   if (!followsClubRules(s, teams)) throw Error('Club Wars requires two teammates from each club.');
   assertLinkedLineup(s, teams);
   const reserved = manualPlans(s).filter(plan => plan.courtId !== court.id).flatMap(plan => plan.teams.flat());
   if (teams.flat().some(id => reserved.includes(id))) throw Error('A selected player is already assigned to another court’s manual lineup.');
   (s.nextOverrides ??= {})[court.id] = teams;
   break;
 }
 case 'hardCap': {
   if (typeof action.enabled !== 'boolean') throw Error(`Choose whether to use the ${CAP_MINUTES}-minute hard cap.`);
   s.hardCap = action.enabled;
   break;
 }
 case 'linkPartners': {
   const first = s.players.find(player => player.id === str('playerId'));
   const second = s.players.find(player => player.id === str('partnerId'));
   if (!first || !second || first === second || first.status === 'checkedOut' || second.status === 'checkedOut') {
     throw Error('Choose two different checked-in players.');
   }
   if (first.partnerId || second.partnerId) throw Error('Unlink either player’s current partner first.');
   if (s.queueMode === 'clubs' && (!first.side || first.side !== second.side)) {
     throw Error('Linked teammates must be from the same club in Club Wars.');
   }
   if (s.queueMode === 'mixed' && (!first.division || !second.division || first.division === second.division)) {
     throw Error('Linked teammates need different divisions in Mixed Doubles.');
   }
   first.partnerId = second.id;
   second.partnerId = first.id;
   const linked = playerLinks(s.players);
   for (const [id, teams] of Object.entries(s.nextOverrides ?? {})) {
     if (!keepsLinkedPartners(teams, linked)) delete s.nextOverrides![id];
   }
   break;
 }
 case 'unlinkPartners': {
   const player = s.players.find(p => p.id === str('playerId'));
   if (!player?.partnerId) throw Error('This player has no linked teammate.');
   unlinkPartner(s, player);
   break;
 }
 case 'clearNextLineup':
   if (court && s.nextOverrides) delete s.nextOverrides[court.id];
   break;
 case 'checkoutPlayer': {
   const player = s.players.find(p => p.id === str('playerId'));
   if (!player || player.status === 'checkedOut') throw Error('This player is already checked out.');
   if (player.status === 'playing') {
     const current = s.courts.find(c => c.match?.teams.flat().includes(player.id));
     if (!current?.match || current.match.id !== str('matchId')) {
       throw Error('This player is on court. Reopen checkout to confirm ending their game.');
     }
     finish(s, current, now, 'Not recorded', 'Player checked out');
   }
   player.status = 'checkedOut';
   unlinkPartner(s, player);
   removeReservations(s, [player.id]);
   releaseEntryQueue(s, [player.id]);
   break;
 }
 case 'deletePlayer': {
   const player = s.players.find(item => item.id === str('playerId'));
   if (!player) throw Error('This player has already been deleted.');
   if (player.status === 'playing') {
     const current = s.courts.find(item => item.match?.teams.flat().includes(player.id));
     if (!current?.match || current.match.id !== str('matchId')) {
       throw Error('This player is on court. Reopen Delete player to confirm ending their game.');
     }
     finish(s, current, now, 'Not recorded', 'Player deleted');
   }
   unlinkPartner(s, player);
   removeReservations(s, [player.id]);
   releaseEntryQueue(s, [player.id]);
   s.players = s.players.filter(item => item.id !== player.id);
   s.rotationSelections = s.rotationSelections.filter(id => id !== player.id);
   for (const matrix of [s.partners, s.opponents]) {
     for (const key of Object.keys(matrix)) if (key.split('|').includes(player.id)) delete matrix[key];
   }
   break;
 }
 case 'returnPlayer': {
   const player = s.players.find(p => p.id === str('playerId'));
   if (player?.status !== 'checkedOut') throw Error('This player is already checked in.');
   if (s.capacityLimit !== false && activePlayers(s).length >= s.courts.length * 12) throw Error('Active-player capacity is full.');
   const active = activePlayers(s);
   const average = Math.floor(active.reduce((sum, other) => sum + rotationGames(other), 0) / Math.max(1, active.length));
   player.credit = Math.max(player.credit ?? 0, average - player.games);
   player.status = 'waiting';
   player.waitSince = now;
   player.missed = 0;
   break;
 }
 case 'selfCheckin': {
   if(!s.selfCheckin)throw Error('Player check-in is currently closed.');
   const key=str('checkInKey');
   if(!/^[a-f0-9-]{36}$/.test(key))throw Error('Reload the check-in form and try again.');
   const existing=s.players.find(p=>p.checkInKey===key);
   if(existing?.status==='checkedOut')throw Error('Ask the organizer to check you back in.');
   if(existing)return input;
   const name=str('name').trim();
   if(!name||name.length>60)throw Error('Enter a name of up to 60 characters.');
   if(s.players.some(p=>p.name.toLowerCase()===name.toLowerCase()))throw Error('This name is already checked in. Ask the organizer if you need help.');
   if(s.queueMode==='mixed'&&action.division!=='men'&&action.division!=='women')throw Error('Choose a mixed doubles category.');
   const rating=isAtrMode(s.queueMode)?'':validateRating(action.skill,true);
   const photo=validateHeadshot(action.photo);
   const added=applyAction(s,{type:'addPlayers',names:[name],skill:rating,side:action.side},now);
   const player=added.players[added.players.length-1];
   player.photo=photo;
   player.checkInKey=key;
   player.division=action.division==='men'||action.division==='women'?action.division:undefined;
   return added;
 }
 case 'playerProfile': {
   const player=s.players.find(p=>p.id===str('playerId'));
   if(!player)throw Error('Player not found.');
   const skill=action.skill===undefined?player.skill:validateRating(action.skill);
   if(skill&&!/^[1-5](?:\.\d{1,2})?\+?$/.test(skill))throw Error('Enter a rating from 1.0 to 5.9.');
   player.skill=skill;
   if(action.photo!==undefined)player.photo=validateHeadshot(action.photo);
   player.division=action.division==='men'||action.division==='women'?action.division:undefined;
   if (s.queueMode === 'clubs' && action.side !== undefined) {
     player.side = action.side === 'A' || action.side === 'B' ? action.side : undefined;
   }
   break;
 }
 case 'queueSettings': {
   const mode=QUEUE_MODES.find(([key])=>key===action.queueMode);
   if(!mode)throw Error('ATR is the only matching mode.');
   if (Object.hasOwn(action, 'fifo')) throw Error('FIFO is no longer a separate setting. ATR handles queue priority.');
   if (action.capacityLimit !== undefined) {
     if (typeof action.capacityLimit !== 'boolean') throw Error('Choose whether to limit players per court.');
     s.capacityLimit = action.capacityLimit;
   }
   s.queueMode=mode[0];
   delete s.clubs;
   for (const [id, teams] of Object.entries(s.nextOverrides ?? {})) {
     if (!followsClubRules(s, teams)) delete s.nextOverrides![id];
   }
   s.showStandings=action.showStandings===true;
   if(action.selfCheckin!==undefined)s.selfCheckin=action.selfCheckin===true;
   break;
 }
 case 'shuffle':s.seed++;break;
 case 'simulate':for(const c of s.courts)if(c.match)finish(s,c,now,'Not recorded','Simulated round');s.updatedAt=now;fill(s,s.courts.map(c=>c.id),now);break;
 case 'demo':{if(s.courts.length<2)throw Error('Add a second court before loading the 24-player demo.');const d=demoSession(now);d.courts=s.courts.map((c,i)=>({...c,match:s.queueMode==='clubs'?null:d.courts[i]?.match??null}));if(s.queueMode==='clubs')for(const player of d.players)player.status='waiting';s={...d,id:s.id,club:s.club,title:s.title,primary:s.primary,accent:s.accent,logo:s.logo,slogan:s.slogan,queueMode:'atr',showStandings:s.showStandings,selfCheckin:s.selfCheckin,hardCap:s.hardCap,capacityLimit:s.capacityLimit,revision:s.revision};break;}
 case 'clear':s={...emptySession(now),id:s.id,club:s.club,title:s.title,primary:s.primary,accent:s.accent,logo:s.logo,slogan:s.slogan,queueMode:'atr',showStandings:s.showStandings,selfCheckin:s.selfCheckin,hardCap:s.hardCap,capacityLimit:s.capacityLimit,revision:s.revision,courts:s.courts.map(c=>({...c,match:null}))};break;
 case 'settings':{const primary=str('primary'),accent=str('accent');if(!/^#[0-9a-f]{6}$/i.test(primary)||!/^#[0-9a-f]{6}$/i.test(accent))throw Error('Use valid six-digit hex colors.');const logo=str('logo');if(logo&&!logo.startsWith('/atherton-crest.png')&&!/^data:image\/(png|jpeg|webp);base64,/.test(logo))throw Error('Upload a PNG, JPG, or WebP logo.');if(logo.length>400000)throw Error('Logo file is too large.');if(typeof action.slogan==='string')s.slogan=action.slogan.trim().slice(0,100);s.club=str('club').trim().slice(0,80)||s.club;s.title=str('title').trim().slice(0,80)||s.title;s.primary=primary;s.accent=accent;s.logo=logo||'/atherton-crest.png';s.standardRules=!!action.standardRules;const courtNames=Array.isArray(action.courtNames)?action.courtNames:[];s.courts.forEach((c,i)=>{c.name=String(courtNames[i]??c.name).trim().slice(0,30)||c.name;});break;}
 default:throw Error('Unknown session action.');
 }
 s.globalArchives = input.globalArchives;
 if ((action.type === 'clear' || action.type === 'demo') && (input.history.length || input.players.some(player=>player.games>0))) {
   s.globalArchives = [...(input.globalArchives??[]),{
     players:input.players.map(({name,games})=>({name,games})),history:input.history,
   }];
 }
 s.globalStandingsRoot = input.globalStandingsRoot;
 s.globalStandingsCutoffs = input.globalStandingsCutoffs;
 // Crossing the active-player threshold turns the cap back on after a manual override.
 if (!meetsCapThreshold(input) && meetsCapThreshold(s) && s.hardCap === false) delete s.hardCap;
 if (hardCapEnabled(s)) for (const c of s.courts) if (c.match?.pausedAt != null) {
   c.match.pausedMs += now - c.match.pausedAt;
   c.match.pausedAt = null;
 }
 s.revision++;s.updatedAt=now;return s;
}
