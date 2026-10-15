import test from 'node:test';
import assert from 'node:assert/strict';
import { botChoice, awardSessionWins } from '../server/social.js';

test('bot policy uses public risk and loot with no forced deck knowledge', () => {
  assert.equal(botChoice({bustRiskPercent:0,salvageCache:0},{unbankedScore:0},false,0),'PUSH');
  assert.equal(botChoice({bustRiskPercent:40,salvageCache:24},{unbankedScore:60},false,.1),'EXTRACT');
  assert.equal(botChoice({bustRiskPercent:7,salvageCache:8},{unbankedScore:0},true,.9),'PUSH');
});
test('session victory credits only highest scorers, including ties', () => {
  const room={players:[{bankedScore:60,sessionWins:1},{bankedScore:49,sessionWins:2},{bankedScore:60,sessionWins:0}]};
  awardSessionWins(room);assert.deepEqual(room.players.map(p=>p.sessionWins),[2,2,1]);
});
