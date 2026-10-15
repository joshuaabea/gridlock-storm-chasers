// Bots only receive the public snapshot; they never inspect the deck or human choices.
export const REACTIONS = Object.freeze({ GG: 'Good game!', ESCAPE: 'Nice escape!', AGAIN: 'One more?', READY: 'Ready to chase!' });
export function botChoice(state, player, bold = false, roll = Math.random()) {
  const risk = state.bustRiskPercent / 100;
  const loot = player.unbankedScore;
  if (risk === 0 && state.salvageCache === 0) return 'PUSH';
  const threshold = bold ? 55 : 30;
  const temptation = state.salvageCache >= 16 ? .2 : 0;
  const chance = Math.min(.9, risk * (bold ? 1.2 : 2) + (loot >= threshold ? .35 : 0) + temptation);
  return roll < chance ? 'EXTRACT' : 'PUSH';
}
export function awardSessionWins(room) {
  const best = Math.max(...room.players.map(p => p.bankedScore));
  for (const p of room.players) if (p.bankedScore === best) p.sessionWins = (p.sessionWins ?? 0) + 1;
}
