const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
let state = null, session = null, busy = false, noticeTimer;
try { session = JSON.parse(sessionStorage.getItem('gridlock-session')); } catch { /* Storage unavailable. Play in this tab. */ }
const save = () => { try { sessionStorage.setItem('gridlock-session', JSON.stringify(session)); } catch {} };
function notice(message) {
  $('notice').textContent = message; $('notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 6000);
}
function request(event, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error('Connection lost. Reconnecting…'));
    socket.timeout(5000).emit(event, payload, (error, reply) => {
      if (error) reject(new Error('No server response. Check your connection.'));
      else if (!reply?.ok) reject(new Error(reply?.error || 'Request failed.'));
      else resolve(reply);
    });
  });
}
async function action(fn) {
  if (busy) return;
  busy = true; render();
  try { await fn(); } catch (error) { notice(error.message); }
  finally { busy = false; render(); }
}
function adopt(reply) {
  session = { roomCode: reply.roomCode, token: reply.token, playerId: reply.playerId };
  save(); state = reply.state; render();
}
socket.on('connect', async () => {
  render();
  if (session) {
    busy = true; render();
    try { adopt(await request('resume_session', session)); }
    catch (error) { session = null; state = null; save(); notice(error.message); }
    finally { busy = false; render(); }
  }
});
socket.on('disconnect', () => render());
socket.on('connect_error', () => { $('connection').textContent = 'Server unavailable'; });
socket.on('state_update', next => { state = next; render(); });
$('entry-form').addEventListener('submit', event => {
  event.preventDefault(); action(async () => adopt(await request('create_room', { name: $('name').value })));
});
$('join').addEventListener('click', () => {
  if (!$('entry-form').reportValidity()) return;
  action(async () => adopt(await request('join_room', { name: $('name').value, roomCode: $('code').value })));
});
for (const [id,event] of [['practice','practice'],['quick-play','quick_play']]) {
  $(id).addEventListener('click', () => {
    if (!$('entry-form').reportValidity()) return;
    action(async () => adopt(await request(event, { name: $('name').value })));
  });
}
$('wait-practice').addEventListener('click', () => action(async () => {
  const me = state.players.find(p => p.id === session?.playerId);
  adopt(await request('practice', { name: me.name }));
}));
for (const [id,reaction] of [['ready','READY'],['gg','GG'],['escape','ESCAPE'],['again','AGAIN']]) {
  $(`react-${id}`).addEventListener('click', () => action(() => request('react', { reaction })));
}
$('code').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('join').click(); }
});
for (const id of ['start', 'rematch']) $(id).addEventListener('click', () => action(() => request('start_game')));
for (const [id, choice] of [['push', 'PUSH'], ['extract', 'EXTRACT']]) {
  $(id).addEventListener('click', () => {
    const turnId = state?.turnId;
    action(() => request('submit_choice', { choice, turnId }));
  });
}
$('leave').addEventListener('click', () => action(async () => {
  await request('leave_room'); session = null; state = null; save();
}));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.roomCode); notice('Room code copied. Share it with your crew.'); }
  catch { notice(`Share this room code: ${state.roomCode}`); }
});
function cell(row, text, className) {
  const td = document.createElement('td'); td.textContent = text;
  if (className) td.className = className;
  row.append(td);
}
function render() {
  const online = socket.connected;
  $('connection').textContent = online ? 'Uplink connected' : 'Reconnecting…';
  $('connection').classList.toggle('online', online);
  $('home').hidden = !!state; $('room').hidden = !state;
  for (const id of ['create', 'join', 'leave', 'practice', 'quick-play', 'wait-practice', 'react-ready', 'react-gg', 'react-escape', 'react-again']) $(id).disabled = busy || !online;
  if (!state) return;
  const me = state.players.find(p => p.id === session?.playerId);
  const lobby = state.phase === 'LOBBY', over = state.phase === 'GAME_OVER';
  const publicRoom = state.mode === 'PUBLIC';
  $('mode-label').textContent = state.mode === 'PRACTICE' ? 'PRACTICE · COMPUTER OPPONENTS' : publicRoom ? 'PUBLIC QUICK PLAY · HUMAN CREWS' : 'PRIVATE EXPEDITION';
  $('room-code').textContent = state.roomCode;
  $('wait-practice').hidden = !(publicRoom && lobby);
  $('lobby-title').textContent = publicRoom ? 'Finding your crew.' : 'Assemble your crew.';
  $('lobby-description').textContent = publicRoom ? 'Human players only. Starts automatically 10 seconds after a second crew arrives. No one online? Practice is ready now.' : 'Share the room code. Every crew joins on their own screen.';
  $('lobby').hidden = !lobby; $('mission').hidden = lobby || over; $('results').hidden = !over;
  const connected = state.players.filter(p => p.connected).length;
  $('crew-count').textContent = `${connected} CONNECTED / ${state.players.length} CREWS`;
  $('lobby-message').textContent = me?.isHost ? `${connected}/8 crews connected. ${connected < 2 ? 'Waiting for one more crew.' : 'Ready when you are.'}` : 'Waiting for the host to launch.';
  if (publicRoom && lobby) $('lobby-message').textContent = state.queueRemaining === null ? 'Waiting for another human player. No bots will be added.' : `${connected} crews ready. Starting in ${state.queueRemaining}s…`;
  for (const id of ['start', 'rematch']) {
    $(id).hidden = !me?.isHost || (id === 'start' && publicRoom);
    $(id).disabled = busy || !online || connected < 2;
  }
  $('rematch-note').textContent = me?.isHost ? (connected < 2 ? 'A second connected crew is needed for a rematch.' : 'Rematch resets scores for connected crews.') : 'Waiting for the host to launch a rematch.';
  const sorted = over ? [...state.players].sort((a, b) => b.bankedScore - a.bankedScore) : state.players;
  $('players').replaceChildren(...sorted.map(p => {
    const row = document.createElement('tr');
    cell(row, `${p.name}${p.id === me?.id ? ' · YOU' : ''}${p.isHost ? ' · HOST' : ''}${p.isBot ? ' · BOT' : ''}`, p.id === me?.id ? 'you' : '');
    cell(row, !p.connected ? 'OFFLINE' : lobby ? 'READY' : p.status);
    cell(row, p.unbankedScore); cell(row, p.bankedScore); cell(row, p.sessionWins ?? 0);
    cell(row, state.phase === 'DECISION' ? (p.status !== 'ACTIVE' ? '—' : p.hasLockedChoice ? 'LOCKED ✓' : 'Choosing…') : p.lastChoice ?? '—');
    return row;
  }));
  $('social-panel').hidden = !(lobby || over);
  $('reaction-feed').replaceChildren(...(state.reactions ?? []).map(r => {
    const line = document.createElement('p'); line.textContent = `${r.name}: ${r.text}`; return line;
  }));
  $('event').textContent = state.lastEventLog;
  if (over) {
    const top = Math.max(...state.players.map(p => p.bankedScore));
    const winners = state.players.filter(p => p.bankedScore === top).map(p => p.name);
    $('winner').textContent = `${winners.join(' & ')} ${winners.length === 1 ? 'wins' : 'share victory'} · ${top} pts`;
  }
  if (lobby || over) { $('room').classList.toggle('has-actions', false); return; }
  $('storm-label').textContent = `STORM ${state.stormNumber}/3`;
  $('turn-label').textContent = `TURN ${state.turnNumber}`;
  $('deck-label').textContent = `DECK: ${state.cardsRemaining}`;
  $('phase-label').textContent = state.phase.replaceAll('_', ' ');
  const card = state.currentCard, hazard = card?.type === 'HAZARD';
  $('card').classList.toggle('hazard', hazard);
  $('card-type').textContent = hazard ? 'HAZARD DETECTED' : 'TELEMETRY ACQUIRED';
  $('card-symbol').textContent = hazard ? (card.title === 'Lightning Strike' ? 'ϟ' : card.title === 'EMP Surge' ? '◎' : '≋') : `+${card?.value ?? 0}`;
  $('card-title').textContent = card?.title ?? 'Storm complete';
  $('card-description').textContent = hazard ? 'A second matching hazard wipes active crews’ data.' : 'Points divided equally between crews still in the field.';
  $('salvage').textContent = state.salvageCache; $('unbanked').textContent = me?.unbankedScore ?? 0; $('banked').textContent = me?.bankedScore ?? 0;
  $('hazards').replaceChildren(...state.activeHazards.map(h => {
    const tag = document.createElement('span'); tag.className = 'hazard-pill'; tag.textContent = h; return tag;
  }));
  $('warning').textContent = state.phase === 'STORM_END'
    ? (state.stormBusted ? 'Catastrophic failure! Active crews wiped.' : 'Safe extraction. Banked points are secure.')
    : state.hazardWarning || 'No hazards detected. The next card could change that.';
  $('warning').classList.toggle('ended', state.phase === 'STORM_END');
  $('warning').classList.toggle('busted', state.stormBusted);
  $('timer').textContent = state.timerRemaining;
  $('timer-caption').textContent = state.phase === 'DECISION' ? 'SECONDS TO DECIDE' : 'SECONDS TO NEXT PHASE';
  const canChoose = state.phase === 'DECISION' && me?.status === 'ACTIVE' && !me.hasLockedChoice;
  const showActions = state.phase === 'DECISION' && me?.status === 'ACTIVE';
  $('decision-dock').hidden = !showActions;
  $('room').classList.toggle('has-actions', showActions);
  $('decision-buttons').hidden = !showActions;
  $('status-summary').hidden = showActions;
  $('status-summary').classList.toggle('busted', state.stormBusted);
  $('decision-help').hidden = !showActions;
  $('push-label').textContent = 'Push deeper';
  $('push-risk').textContent = `${state.bustRiskPercent}% next-draw bust risk`;
  $('dock-clock').textContent = online ? `${state.timerRemaining}s` : 'Offline';
  const extractionValue = `Bank ${me?.unbankedScore ?? 0} pts. Extract alone: +${state.salvageCache} salvage (${(me?.unbankedScore ?? 0) + state.salvageCache} total).`;
  $('extract-preview').textContent = me?.hasLockedChoice ? 'Decision locked. Waiting for the other crews.' : extractionValue;
  $('push').disabled = $('extract').disabled = !canChoose || busy || !online;
  let title, detail;
  if (state.phase === 'STORM_END') {
    title = state.stormBusted ? 'STORM BUSTED!' : 'Safely extracted.';
    detail = state.stormBusted
      ? state.stormLosses.map(loss => `${loss.name} lost ${loss.lostPoints} unbanked pts`).join(' · ')
      : 'Every crew made it back to base. Banked points are secure.';
  }
  else if (state.phase === 'TURN_SUMMARY') { title = 'The crews have spoken.'; detail = 'Choices are revealed below. The expedition continues shortly.'; }
  else if (me?.status === 'EXTRACTED') { title = 'Safe at base.'; detail = 'Your data is banked. Watch the remaining crews take their chances.'; }
  else if (me?.hasLockedChoice) { title = 'Decision locked.'; detail = 'Waiting for the other crews. Your choice stays private until resolution.'; }
  else { title = 'Stay or extract?'; detail = state.salvageCache > 0
    ? `Bank ${me?.unbankedScore ?? 0} points. Extract alone to claim ${state.salvageCache} salvage—${(me?.unbankedScore ?? 0) + state.salvageCache} total. If others extract too, you bank only your telemetry.`
    : `Bank ${me?.unbankedScore ?? 0} points now, or push for another card. There is no salvage on the table.`; }
  const receipt = me?.extractionReceipt;
  $('receipt').hidden = !receipt;
  if (receipt) {
    $('receipt-label').textContent = `EXTRACTION RECEIPT · TURN ${receipt.turnNumber}`;
    $('receipt-telemetry').textContent = `${receipt.telemetry} pts`;
    $('receipt-salvage').textContent = `${receipt.salvage} pts`;
    $('receipt-total').textContent = `+${receipt.total} pts`;
    $('receipt-banked').textContent = `${receipt.bankedTotal} pts`;
  }
  $('decision-title').textContent = title; $('decision-detail').textContent = detail;
  $('status-summary-label').textContent = state.phase === 'STORM_END'
    ? (state.stormBusted ? 'DAMAGE REPORT' : 'EXTRACTION COMPLETE')
    : state.phase === 'TURN_SUMMARY' ? 'TURN RESOLVED' : 'CREW SECURED';
  $('status-summary-text').textContent = state.phase === 'STORM_END'
    ? `Your banked score: ${me?.bankedScore ?? 0} pts. ${state.stormNumber === 3 ? 'Final standings' : 'Next storm'} in ${state.timerRemaining}s.`
    : state.phase === 'TURN_SUMMARY' ? `${state.lastEventLog} Next card in ${state.timerRemaining}s.`
    : `You have ${me?.bankedScore ?? 0} pts safely banked. Waiting for the crews still in the field.`;
}
render(); socket.connect();
