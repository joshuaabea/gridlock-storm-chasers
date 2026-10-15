import { randomInt } from 'node:crypto';

export const HAZARDS = ['Lightning Strike', 'EMP Surge', 'Tornado Vortex'];
export const VALUES = [10, 15, 20, 25, 30, 35, 40, 50, 60];

export function makeDeck() {
  const deck = [
    ...VALUES.map(value => ({ type: 'TELEMETRY', title: 'Core Reading', value })),
    ...HAZARDS.flatMap(title => [{ type: 'HAZARD', title }, { type: 'HAZARD', title }]),
  ];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function makeRoom(roomCode) {
  return { roomCode, mode: 'PRIVATE', reactions: [], queueDeadline: null, phase: 'LOBBY', stormNumber: 0, maxStorms: 3,
    currentCard: null, activeHazards: [], salvageCache: 0, deadline: null,
    stormBusted: false, stormLosses: [],
    turnNumber: 0, turnId: 0, lastEventLog: 'Assemble your crew. Two players minimum.',
    players: [], deck: [], choices: new Map(), timer: null, emptySince: null };
}

export const activePlayers = room => room.players.filter(p => p.status === 'ACTIVE');

export function beginStorm(room, deck = makeDeck()) {
  room.stormNumber++;
  room.deck = deck;
  room.activeHazards = [];
  room.salvageCache = 0;
  room.stormBusted = false;
  room.stormLosses = [];
  room.currentCard = null;
  room.turnNumber = 0;
  room.choices.clear();
  for (const p of room.players) {
    p.status = p.connected ? 'ACTIVE' : 'EXTRACTED';
    p.unbankedScore = 0;
    p.lastChoice = null;
    p.extractionReceipt = null;
  }
  revealCard(room);
}

export function endStorm(room, message, busted = false) {
  room.phase = 'STORM_END';
  room.stormBusted = busted;
  room.deadline = null;
  room.lastEventLog = message;
}

// Internal action; clients cannot request draws or supply deck/score values.
export function revealCard(room) {
  room.choices.clear();
  for (const p of room.players) p.lastChoice = null;
  const active = activePlayers(room);
  if (!active.length) return endStorm(room, 'All crews are back at base. Storm complete.');
  const card = room.deck.shift();
  // Defensive fallback. A normal 15-card deck necessarily busts before exhaustion.
  if (!card) {
    for (const p of active) {
      p.bankedScore += p.unbankedScore;
      p.unbankedScore = 0;
      p.status = 'EXTRACTED';
    }
    return endStorm(room, 'Deck exhausted. Remaining telemetry banked; salvage discarded.');
  }
  room.currentCard = card;
  room.turnNumber++;
  room.turnId++;
  const prefix = `Storm ${room.stormNumber}, Turn ${room.turnNumber}: `;
  if (card.type === 'TELEMETRY') {
    const share = Math.floor(card.value / active.length);
    for (const p of active) p.unbankedScore += share;
    room.salvageCache += card.value % active.length;
    room.lastEventLog = `${prefix}+${card.value} pts split among ${active.length} crews (+${share} each).`;
  } else {
    const duplicate = room.activeHazards.includes(card.title);
    room.activeHazards.push(card.title);
    if (duplicate) {
      room.stormLosses = active.map(p => ({ id: p.id, name: p.name, lostPoints: p.unbankedScore }));
      for (const p of active) { p.unbankedScore = 0; p.status = 'BUSTED'; }
      return endStorm(room, `${prefix}Second ${card.title}! Active crews lost their unbanked data.`, true);
    }
    room.salvageCache += 8;
    room.lastEventLog = `${prefix}${card.title} detected! +8 added to Salvage Cache.`;
  }
  room.phase = 'DECISION';
}

export function lockChoice(room, player, choice, turnId) {
  if (room.phase !== 'DECISION' || player.status !== 'ACTIVE') throw new Error('You cannot choose right now.');
  if (turnId !== room.turnId) throw new Error('That turn has already ended.');
  if (!['PUSH', 'EXTRACT'].includes(choice)) throw new Error('Invalid choice.');
  if (room.choices.has(player.id)) throw new Error('Your choice is already locked.');
  room.choices.set(player.id, choice);
}

export function resolveChoices(room) {
  if (room.phase !== 'DECISION') return;
  const active = activePlayers(room);
  const extracting = active.filter(p => (room.choices.get(p.id) ?? 'EXTRACT') === 'EXTRACT');
  for (const p of active) {
    const choice = room.choices.get(p.id) ?? 'EXTRACT';
    room.choices.set(p.id, choice);
    p.lastChoice = choice;
    if (choice === 'EXTRACT') {
      const telemetry = p.unbankedScore;
      const salvage = extracting.length === 1 ? room.salvageCache : 0;
      p.bankedScore += telemetry + salvage;
      p.extractionReceipt = { stormNumber: room.stormNumber, turnNumber: room.turnNumber,
        telemetry, salvage, total: telemetry + salvage, bankedTotal: p.bankedScore };
      p.unbankedScore = 0;
      p.status = 'EXTRACTED';
    }
  }
  const salvage = room.salvageCache;
  if (extracting.length === 1) room.salvageCache = 0;
  room.phase = 'TURN_SUMMARY';
  room.deadline = null;
  room.lastEventLog = `${extracting.length} extracted; ${active.length - extracting.length} pushing deeper.`
    + (extracting.length === 1 ? ` ${extracting[0].name} claimed ${salvage} salvage.` : ' Salvage stays on the table.');
  // Preserve revealed choices, but skip the summary countdown when no crew remains.
  if (!activePlayers(room).length) {
    endStorm(room, `All crews safely extracted. ${extracting.length === 1
      ? `${extracting[0].name} claimed ${salvage} salvage.`
      : `${salvage} unclaimed salvage left behind.`}`);
  }
}

export function snapshot(room, now = Date.now()) {
  const warnings = [...new Set(room.activeHazards)].map(h => `1 more ${h} will wipe unbanked data!`);
  const cardsRemaining = room.deck.length;
  // Each unique hazard in a live storm has one matching copy left. No next draw after storm end.
  const bustRiskPercent = cardsRemaining > 0 && ['DECISION', 'TURN_SUMMARY'].includes(room.phase)
    ? Math.round(new Set(room.activeHazards).size / cardsRemaining * 100) : 0;
  return {
    roomCode: room.roomCode, mode: room.mode, phase: room.phase, stormNumber: room.stormNumber,
    queueRemaining: room.queueDeadline ? Math.max(0, Math.ceil((room.queueDeadline - now) / 1000)) : null,
    reactions: room.reactions.map(r => ({ ...r })),
    maxStorms: room.maxStorms, currentCard: room.currentCard ? { ...room.currentCard } : null,
    activeHazards: [...room.activeHazards], hazardWarning: warnings.join(' '),
    salvageCache: room.salvageCache,
    cardsRemaining, bustRiskPercent, stormBusted: room.stormBusted,
    stormLosses: room.stormLosses.map(loss => ({ ...loss })),
    timerRemaining: room.deadline ? Math.max(0, Math.ceil((room.deadline - now) / 1000)) : 0,
    lastEventLog: room.lastEventLog,
    // Additive identifiers reject stale client requests, including after a rematch.
    turnNumber: room.turnNumber, turnId: room.turnId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, status: p.status,
      unbankedScore: p.unbankedScore, bankedScore: p.bankedScore,
      hasLockedChoice: room.choices.has(p.id),
      lastChoice: room.phase === 'DECISION' ? null : p.lastChoice,
      connected: p.connected, isBot: !!p.isBot, sessionWins: p.sessionWins ?? 0,
      extractionReceipt: p.extractionReceipt ? { ...p.extractionReceipt } : null,
    })),
  };
}
