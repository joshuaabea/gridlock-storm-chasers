import test from 'node:test';
import assert from 'node:assert/strict';
import { HAZARDS, VALUES, makeDeck, makeRoom, beginStorm, revealCard, lockChoice, resolveChoices, snapshot } from '../server/game.js';

const telemetry = value => ({ type: 'TELEMETRY', title: 'Core Reading', value });
const hazard = title => ({ type: 'HAZARD', title });
function fixture(count = 3) {
  const room = makeRoom('TEST');
  room.players = Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Crew ${i}`, connected: true,
    isHost: i === 0, status: 'ACTIVE', bankedScore: 0, unbankedScore: 0, lastChoice: null, token: `secret-${i}`, socketId: `socket-${i}` }));
  return room;
}
function choose(room, choices) {
  choices.forEach((choice, i) => lockChoice(room, room.players[i], choice, room.turnId));
  resolveChoices(room);
}

test('deck contains the exact nine values and two of each hazard', () => {
  for (let n = 0; n < 20; n++) {
    const deck = makeDeck();
    assert.equal(deck.length, 15);
    assert.deepEqual(deck.filter(c => c.type === 'TELEMETRY').map(c => c.value).sort((a,b) => a-b), VALUES);
    for (const title of HAZARDS) assert.equal(deck.filter(c => c.title === title).length, 2);
  }
});
test('telemetry conserves points for every supported crew count and card value', () => {
  for (let n = 2; n <= 8; n++) for (const value of VALUES) {
    const room = fixture(n); beginStorm(room, [telemetry(value)]);
    assert.equal(room.players.reduce((sum,p) => sum + p.unbankedScore, 0) + room.salvageCache, value);
    assert.ok(room.players.every(p => p.unbankedScore === Math.floor(value/n)));
  }
});
test('one extractor gets unbanked points plus accumulated salvage; remaining crews share future cards', () => {
  const room = fixture(); beginStorm(room, [telemetry(10), telemetry(20)]);
  choose(room, ['EXTRACT','PUSH','PUSH']);
  assert.equal(room.players[0].bankedScore, 4); assert.equal(room.salvageCache, 0);
  revealCard(room);
  assert.equal(room.players[0].unbankedScore, 0);
  assert.equal(room.players[1].unbankedScore, 13);
});
test('simultaneous extractions leave salvage for a later lone extractor', () => {
  const room = fixture(); beginStorm(room, [telemetry(10), telemetry(20)]);
  choose(room, ['EXTRACT','EXTRACT','PUSH']);
  assert.equal(room.salvageCache, 1); assert.equal(room.players[0].bankedScore, 3);
  revealCard(room); lockChoice(room, room.players[2], 'EXTRACT', room.turnId); resolveChoices(room);
  assert.equal(room.players[2].bankedScore, 24);
  revealCard(room); assert.equal(room.phase, 'STORM_END');
});
test('different hazards are safe; second exact match busts only active crews', () => {
  const room = fixture(2);
  beginStorm(room, [telemetry(30), hazard(HAZARDS[0]), hazard(HAZARDS[1]), hazard(HAZARDS[0])]);
  choose(room, ['EXTRACT','PUSH']);
  revealCard(room); assert.equal(room.phase, 'DECISION');
  lockChoice(room, room.players[1], 'PUSH', room.turnId); resolveChoices(room); revealCard(room);
  assert.equal(room.phase, 'DECISION');
  lockChoice(room, room.players[1], 'PUSH', room.turnId); resolveChoices(room); revealCard(room);
  assert.equal(room.phase, 'STORM_END');
  assert.equal(room.players[1].status, 'BUSTED'); assert.equal(room.players[1].unbankedScore, 0);
  assert.equal(room.players[0].bankedScore, 15); assert.equal(room.players[0].status, 'EXTRACTED');
});
test('snapshot hides choices, tokens, sockets, deck, and internal maps', () => {
  const room = fixture(); beginStorm(room, [telemetry(10)]);
  lockChoice(room, room.players[0], 'PUSH', room.turnId);
  const view = snapshot(room);
  assert.equal(view.players[0].hasLockedChoice, true); assert.equal(view.players[0].lastChoice, null);
  const json = JSON.stringify(view);
  for (const secret of ['secret-', 'socket-', 'choices', 'deck', 'deadline']) assert.ok(!json.includes(secret));
  resolveChoices(room); assert.equal(snapshot(room).players[0].lastChoice, 'PUSH');
});
test('missing choices extract and cannot claim salvage when multiple crews time out', () => {
  const room = fixture(); beginStorm(room, [telemetry(10)]);
  lockChoice(room, room.players[0], 'PUSH', room.turnId); resolveChoices(room);
  assert.deepEqual(room.players.map(p => p.status), ['ACTIVE','EXTRACTED','EXTRACTED']);
  assert.equal(room.salvageCache, 1);
});
test('invalid, duplicate, stale and out-of-phase choices are rejected', () => {
  const room = fixture(); beginStorm(room, [telemetry(10)]); const p = room.players[0];
  assert.throws(() => lockChoice(room,p,'CHEAT',room.turnId));
  assert.throws(() => lockChoice(room,p,'PUSH',room.turnId-1));
  lockChoice(room,p,'PUSH',room.turnId);
  assert.throws(() => lockChoice(room,p,'EXTRACT',room.turnId));
  resolveChoices(room); assert.throws(() => lockChoice(room,p,'PUSH',room.turnId));
});
test('fresh storm resets risk but retains banked score and excludes offline crews', () => {
  const room = fixture(2); beginStorm(room, [telemetry(30)]); resolveChoices(room);
  room.players[1].connected = false; room.salvageCache = 10;
  beginStorm(room, [telemetry(20)]);
  assert.equal(room.stormNumber, 2); assert.equal(room.salvageCache, 0);
  assert.deepEqual(room.players.map(p => p.bankedScore), [15,15]);
  assert.deepEqual(room.players.map(p => p.unbankedScore), [20,0]);
  assert.equal(room.players[1].status, 'EXTRACTED');
});
test('snapshot countdown never becomes negative', () => {
  const room = fixture(); room.deadline = 2000;
  assert.equal(snapshot(room, 1001).timerRemaining, 1);
  assert.equal(snapshot(room, 3000).timerRemaining, 0);
});

test('Turn 1 hazard creates eight salvage points that a lone extractor can bank', () => {
  const room = fixture(2);
  beginStorm(room, [hazard(HAZARDS[0]), telemetry(10)]);
  assert.equal(room.salvageCache, 8);
  assert.match(room.lastEventLog, /Lightning Strike detected! \+8 added to Salvage Cache\./);
  choose(room, ['EXTRACT', 'PUSH']);
  assert.equal(room.players[0].bankedScore, 8);
  assert.equal(room.salvageCache, 0);
});

test('live deck counter and rounded bust risk track each draw; ended/empty decks return zero', () => {
  const room = fixture(2), deck = makeDeck();
  const first = deck.splice(deck.findIndex(c => c.title === HAZARDS[0]), 1)[0];
  const second = deck.splice(deck.findIndex(c => c.title === HAZARDS[1]), 1)[0];
  beginStorm(room, [first, second, ...deck]);
  assert.equal(snapshot(room).cardsRemaining, 14);
  assert.equal(snapshot(room).bustRiskPercent, 7);
  choose(room, ['PUSH','PUSH']); revealCard(room);
  assert.equal(snapshot(room).cardsRemaining, 13);
  assert.equal(snapshot(room).bustRiskPercent, 15);
  assert.equal(room.salvageCache, 16);
  choose(room, ['EXTRACT','EXTRACT']);
  assert.equal(snapshot(room).bustRiskPercent, 0);
  room.deck = [];
  assert.equal(snapshot(room).bustRiskPercent, 0);
});

test('bust captures individual losses without awarding salvage, then clears report next storm', () => {
  const room = fixture(3);
  beginStorm(room, [telemetry(30), hazard(HAZARDS[0]), hazard(HAZARDS[0])]);
  choose(room, ['EXTRACT','PUSH','PUSH']); revealCard(room);
  lockChoice(room, room.players[1], 'PUSH', room.turnId);
  lockChoice(room, room.players[2], 'PUSH', room.turnId);
  resolveChoices(room); revealCard(room);
  const view = snapshot(room);
  assert.equal(view.stormBusted, true); assert.equal(view.salvageCache, 8);
  assert.deepEqual(view.stormLosses, [
    {id:'1', name:'Crew 1', lostPoints:10}, {id:'2', name:'Crew 2', lostPoints:10},
  ]);
  assert.equal(room.players[0].bankedScore, 10);
  beginStorm(room, [telemetry(10)]);
  assert.equal(snapshot(room).stormBusted, false);
  assert.deepEqual(snapshot(room).stormLosses, []);
});

test('last extraction skips TURN_SUMMARY but preserves simultaneously revealed choices', () => {
  const room = fixture(2); beginStorm(room, [telemetry(20)]);
  choose(room, ['EXTRACT','EXTRACT']);
  assert.equal(room.phase, 'STORM_END'); assert.equal(room.stormBusted, false);
  assert.deepEqual(snapshot(room).players.map(p => p.lastChoice), ['EXTRACT','EXTRACT']);
  assert.deepEqual(room.players.map(p => p.bankedScore), [10,10]);
});

test('extraction receipt survives later draws, preserves score breakdown, and resets next storm', () => {
  const room = fixture(2);
  room.players[0].bankedScore = 10;
  beginStorm(room, [telemetry(50), hazard(HAZARDS[0]), telemetry(20)]);
  choose(room,['PUSH','PUSH']); revealCard(room);
  choose(room,['EXTRACT','PUSH']);
  const receipt = snapshot(room).players[0].extractionReceipt;
  assert.deepEqual(receipt,{stormNumber:1,turnNumber:2,telemetry:25,salvage:8,total:33,bankedTotal:43});
  revealCard(room);
  assert.deepEqual(snapshot(room).players[0].extractionReceipt,receipt);
  beginStorm(room,[telemetry(10)]);
  assert.equal(snapshot(room).players[0].extractionReceipt,null);
});

test('simultaneous extractors get receipts with zero salvage and the exact banked delta', () => {
  const room = fixture(2); beginStorm(room,[hazard(HAZARDS[0]),telemetry(30)]);
  choose(room,['PUSH','PUSH']); revealCard(room); choose(room,['EXTRACT','EXTRACT']);
  for (const p of snapshot(room).players) {
    assert.equal(p.extractionReceipt.telemetry,15);
    assert.equal(p.extractionReceipt.salvage,0);
    assert.equal(p.extractionReceipt.total,15);
    assert.equal(p.extractionReceipt.bankedTotal,p.bankedScore);
  }
  assert.equal(room.salvageCache,8);
});
