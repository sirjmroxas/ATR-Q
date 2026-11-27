import type { Player, Session } from './engine';

export const DEFAULT_SLOGAN = 'Good games. Better company.';
export const QUEUE_MODES = [
  ['atr', 'ATR matching', 'Fresh partners and first-time encounters come first. Queue order and wait protection keep rotations fair. With 20+ active players on two courts, players sit out three game starts when enough eligible players are available.'],
] as const;
export type QueueMode = 'atr' | 'atrResults' | 'balanced' | 'social' | 'skill' | 'results' | 'skillCourts' | 'mixed' | 'ladder' | 'clubs';
export const isAtrMode = (mode:QueueMode|undefined) => mode==='atr';

export function clubNames(session: Session) {
  return session.clubs ?? { A: 'Club A', B: 'Club B' };
}

export function clubLineupIsValid(sides: (Player['side'] | undefined)[]) {
  const [first, second, third, fourth] = sides;
  return (first === 'A' || first === 'B') && first === second &&
    (third === 'A' || third === 'B') && third === fourth && first !== third;
}

export function ladderTargets(session: Session) {
  const targets = new Map<string, number>();
  for (const { game, winner } of scoredGames(session)) {
    const court = session.courts.findIndex(item => game.courtId ? item.id === game.courtId : item.name === game.court);
    game.teams.forEach((team, index) => {
      for (const id of team) {
        if (court < 0) targets.delete(id);
        else targets.set(id, Math.max(0, Math.min(session.courts.length - 1, court + (index === winner ? -1 : 1))));
      }
    });
  }
  return targets;
}

type RecordedResult = {game:Session['history'][number];points:number[]|null;winner:number;loser:number};
export function scoredGames(session: Pick<Session,'history'>) {
  return [...session.history].reverse().flatMap<RecordedResult>(game => {
    if (game.winner === 0 || game.winner === 1) {
      return [{game,points:null,winner:game.winner,loser:1-game.winner}];
    }
    const score = /^(\d+)\s*[–-]\s*(\d+)$/.exec(game.score);
    if (!score || game.reason === 'Early rotation' || Number(score[1]) === Number(score[2])) return [];
    const points = [Number(score[1]), Number(score[2])];
    const winner = points[0] > points[1] ? 0 : 1;
    return [{ game, points, winner, loser: 1 - winner }];
  });
}

export function sessionResults(session: Session) {
  const standings = session.players.map(player => ({
    id: player.id, name: player.name, games: player.games, wins: 0, losses: 0, streak: 0, diff: 0,
  }));
  const byId = new Map(standings.map(row => [row.id, row]));
  const latest = new Map<string, 'win' | 'loss'>();
  const highlights: { title: string; detail: string }[] = [];
  for (const { game, points, winner, loser } of scoredGames(session)) {
    const winners = game.names[winner].join(' & ');
    const losers = game.names[loser].join(' & ');
    const result = points ? points[winner] + '–' + points[loser] : '';
    if (points && points[winner] === 11 && points[loser] === 0) {
      highlights.push({ title: 'Pickled!', detail: winners + ' won 11–0 against ' + losers + '.' });
    }
    if (points && points[winner] - points[loser] <= 2) {
      highlights.push({ title: 'Close fight', detail: winners + ' edged out ' + losers + ' ' + result + '.' });
    }
    const streaks = game.teams[loser].map(id => byId.get(id)).filter(row => row && row.streak >= 2);
    for (const row of streaks) {
      if (row) highlights.push({ title: 'Streak snapped', detail: winners + ' ended ' + row.name + '’s ' + row.streak + '-game winning streak' + (result ? ', ' + result : '') + '.' });
    }
    game.teams.forEach((team, index) => {
      for (const id of team) {
        const row = byId.get(id);
        if (!row) continue;
        const won = index === winner;
        latest.set(id, won ? 'win' : 'loss');
        if (points) row.diff += points[index] - points[1 - index];
        if (won) {
          row.wins++;
          row.streak++;
        } else {
          row.losses++;
          row.streak = 0;
        }
      }
    });
  }
  return {
    latest,
    standings: standings.filter(row => row.wins + row.losses).sort((a, b) =>
      b.wins - a.wins || a.losses - b.losses || b.diff - a.diff || a.name.localeCompare(b.name)),
    highlights: highlights.reverse().slice(0, 20),
  };
}

export function formatCost(
  mode: QueueMode, players: Player[], courtIndex: number,
  latest: Map<string, 'win' | 'loss'>,
  ladder = new Map<string, number>(),
) {
  const ratings = players.map(player => Number.parseFloat(player.skill));
  const rated = ratings.every(Number.isFinite);
  if (mode === 'balanced') return rated ? 600 * Math.abs(ratings[0] + ratings[1] - ratings[2] - ratings[3]) : 0;
  if (mode === 'skill') return rated && Math.max(...ratings) - Math.min(...ratings) <= 0.5 ? 0 : Infinity;
  if (mode === 'skillCourts') return rated && ratings.every(rating => Number(rating >= 3.5) === courtIndex) ? 0 : Infinity;
  if (mode === 'mixed') {
    const mixed = (a: Player, b: Player) => !!a.division && !!b.division && a.division !== b.division;
    return mixed(players[0], players[1]) && mixed(players[2], players[3]) ? 0 : Infinity;
  }
  if (mode === 'clubs') {
    return clubLineupIsValid(players.map(player => player.side)) ? 0 : Infinity;
  }
  const outcomes = players.map(player => latest.get(player.id));
  if (mode === 'atrResults' || mode === 'results') {
    if (outcomes.includes('win') && outcomes.includes('loss')) return 100000;
    return 0;
  }
  if (mode === 'ladder') {
    return 700 * players.reduce((sum, player) => sum + Math.abs(courtIndex - (ladder.get(player.id) ?? courtIndex)), 0);
  }
  return 0;
}
