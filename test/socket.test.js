import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/app.js';

async function setup(t, options = {}) {
  const server = createGameServer({ decisionMs: 2000, summaryMs: 80, stormEndMs: 80, tickMs: 10, ...options });
  await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const clients = [];
  t.after(async () => { clients.forEach(c => c.disconnect()); await server.close(); });
  async function client() {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.on('state_update', state => socket.latest = state);
    await new Promise((resolve,reject) => { socket.once('connect',resolve); socket.once('connect_error',reject); });
    clients.push(socket); return socket;
  }
  return { server, client, url };
}
const req = (socket, event, data = {}) => new Promise((resolve,reject) => socket.timeout(1500).emit(event, data, (e,r) => e ? reject(e) : resolve(r)));
async function until(predicate, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now()-start > timeout) throw new Error('State wait timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function pair(client) {
  const a = await client(), b = await client();
  const created = await req(a, 'create_room', { name: 'Alpha' });
  assert.equal(created.ok, true);
  const joined = await req(b, 'join_room', { name: 'Bravo', roomCode: created.roomCode });
  assert.equal(joined.ok, true);
  return { a, b, created, joined };
}

test('HTTP serves the buildless app, health check, and local Socket.IO client', async t => {
  const { url } = await setup(t);
  assert.equal((await (await fetch(`${url}/health`)).json()).ok, true);
  const page = await fetch(url); assert.equal(page.status,200);
  assert.match(await page.text(), /Storm Chasers/);
  assert.equal((await fetch(`${url}/socket.io/socket.io.js`)).status,200);
  assert.equal((await fetch(`${url}/styles.css`)).status,200);
});
test('host-only launch, locked choice secrecy, duplicate rejection, and simultaneous resolution', async t => {
  const { client } = await setup(t); const { a,b } = await pair(client);
  assert.equal((await req(b,'start_game')).ok,false);
  assert.equal((await req(a,'start_game')).ok,true);
  await until(() => b.latest?.phase === 'DECISION');
  const turnId = a.latest.turnId;
  assert.equal((await req(a,'submit_choice',{choice:'PUSH',turnId})).ok,true);
  await until(() => b.latest.players[0].hasLockedChoice);
  assert.equal(b.latest.players[0].lastChoice,null);
  assert.equal((await req(a,'submit_choice',{choice:'EXTRACT',turnId})).ok,false);
  assert.equal((await req(b,'submit_choice',{choice:'EXTRACT',turnId})).ok,true);
  await until(() => a.latest.phase === 'TURN_SUMMARY');
  assert.deepEqual(a.latest.players.map(p=>p.lastChoice),['PUSH','EXTRACT']);
});
test('deadline defaults to EXTRACT and stale turn packets cannot alter a later turn', async t => {
  const { server, client } = await setup(t,{decisionMs:130, summaryMs:100}); const { a,b } = await pair(client);
  await req(a,'start_game'); await until(() => a.latest?.phase === 'DECISION');
  const turnId = a.latest.turnId;
  server.rooms.get(a.latest.roomCode).deck = [{type:'TELEMETRY',title:'Core Reading',value:10}];
  await req(a,'submit_choice',{choice:'PUSH',turnId});
  await until(() => a.latest.phase === 'TURN_SUMMARY');
  assert.equal(a.latest.players[1].lastChoice,'EXTRACT');
  await until(() => a.latest.phase === 'DECISION' && a.latest.turnId > turnId);
  assert.equal((await req(a,'submit_choice',{choice:'PUSH',turnId})).ok,false);
  assert.equal((await req(b,'submit_choice',{choice:'PUSH',turnId:a.latest.turnId})).ok,false);
});
test('reconnection restores UUID and locked choice; host transfers without exposing token', async t => {
  const { client } = await setup(t); const { a,b,created } = await pair(client);
  await req(a,'start_game'); await until(() => a.latest.phase === 'DECISION');
  await req(a,'submit_choice',{choice:'PUSH',turnId:a.latest.turnId});
  a.disconnect(); await until(() => b.latest.players[0].connected === false);
  assert.equal(b.latest.players[1].isHost,true);
  const resumed = await client();
  assert.equal((await req(resumed,'resume_session',{roomCode:created.roomCode,token:'bad'})).ok,false);
  const r = await req(resumed,'resume_session',{roomCode:created.roomCode,token:created.token});
  assert.equal(r.ok,true); assert.equal(r.playerId,created.playerId); assert.equal(r.ownChoice,'PUSH');
  assert.equal(r.state.players[0].hasLockedChoice,true);
  assert.ok(!JSON.stringify(b.latest).includes(created.token));
});
test('rooms are isolated and join capacity is exactly eight', async t => {
  const { client } = await setup(t); const { a,created } = await pair(client);
  const outsider = await client(); const other = await req(outsider,'create_room',{name:'Elsewhere'});
  for(let i=2;i<8;i++) {
    const c = await client(); assert.equal((await req(c,'join_room',{name:`Crew${i}`,roomCode:created.roomCode})).ok,true);
  }
  const extra = await client();
  assert.equal((await req(extra,'join_room',{name:'Ninth',roomCode:created.roomCode})).ok,false);
  await req(a,'start_game');
  assert.equal(outsider.latest.roomCode,other.roomCode); assert.equal(outsider.latest.phase,'LOBBY');
  assert.equal((await req(extra,'join_room',{name:'Late',roomCode:created.roomCode})).ok,false);
});
test('three storms finish, preserve scores, and permit a host rematch with fresh scores', async t => {
  const { client } = await setup(t,{decisionMs:60,summaryMs:30,stormEndMs:30});
  const { a,b } = await pair(client); await req(a,'start_game');
  await until(() => a.latest?.phase === 'GAME_OVER');
  assert.equal(a.latest.stormNumber,3);
  assert.ok(a.latest.players.every(p=>p.unbankedScore === 0 && p.bankedScore >= 0));
  const oldTurn = a.latest.turnId;
  assert.equal((await req(b,'start_game')).ok,false);
  assert.equal((await req(a,'start_game')).ok,true);
  await until(() => a.latest.phase === 'DECISION');
  assert.equal(a.latest.stormNumber,1);
  assert.ok(a.latest.players.every(p=>p.bankedScore === 0));
  assert.ok(a.latest.turnId > oldTurn);
});
test('abandoned rooms expire and cannot be resumed', async t => {
  const { server,client } = await setup(t,{emptyTtlMs:40});
  const { a,b,created } = await pair(client); a.disconnect(); b.disconnect();
  await until(() => !server.rooms.has(created.roomCode));
  const c = await client();
  assert.equal((await req(c,'resume_session',{roomCode:created.roomCode,token:created.token})).ok,false);
});

test('default timers are two-second summaries and direct three-second safe storm ends', async t => {
  const { server,client } = await setup(t,{summaryMs:undefined,stormEndMs:undefined});
  const { a,b,created } = await pair(client);
  await req(a,'start_game'); await until(() => a.latest.phase === 'DECISION');
  const turnId = a.latest.turnId;
  server.rooms.get(a.latest.roomCode).deck = [{type:'TELEMETRY',title:'Core Reading',value:10}];
  await req(a,'submit_choice',{choice:'PUSH',turnId});
  await req(b,'submit_choice',{choice:'PUSH',turnId});
  await until(() => a.latest.phase === 'TURN_SUMMARY');
  assert.equal(a.latest.timerRemaining,2);
  server.rooms.get(created.roomCode).deck = [{type:'TELEMETRY',title:'Core Reading',value:10}];
  // Advance this pause directly so the test needn't wait two seconds.
  server.rooms.get(created.roomCode).deadline = Date.now() - 1;
  await until(() => a.latest.phase === 'DECISION');
  const next = a.latest.turnId;
  await req(a,'submit_choice',{choice:'EXTRACT',turnId:next});
  await req(b,'submit_choice',{choice:'EXTRACT',turnId:next});
  await until(() => a.latest.phase === 'STORM_END');
  assert.equal(a.latest.timerRemaining,3);
  assert.equal(a.latest.stormBusted,false);
  assert.deepEqual(a.latest.players.map(p=>p.lastChoice),['EXTRACT','EXTRACT']);
});

test('extracted crew reconnects with the same banked score and authoritative receipt', async t => {
  const { client } = await setup(t,{summaryMs:500});
  const { a,b,created } = await pair(client);
  await req(a,'start_game'); await until(() => a.latest.phase === 'DECISION');
  const turnId = a.latest.turnId;
  await req(a,'submit_choice',{choice:'EXTRACT',turnId});
  await req(b,'submit_choice',{choice:'PUSH',turnId});
  await until(() => a.latest.phase === 'TURN_SUMMARY');
  const before = a.latest.players.find(p=>p.id===created.playerId);
  assert.ok(before.extractionReceipt);
  a.disconnect(); await until(() => b.latest.players[0].connected === false);
  const replacement = await client();
  const response = await req(replacement,'resume_session',{roomCode:created.roomCode,token:created.token});
  assert.equal(response.ok,true);
  const after = response.state.players.find(p=>p.id===created.playerId);
  assert.equal(after.bankedScore,before.bankedScore);
  assert.equal(after.status,'EXTRACTED');
  assert.deepEqual(after.extractionReceipt,before.extractionReceipt);
});

test('public queue excludes private rooms, starts with two humans, and cancels on disconnect', async t => {
  const { server,client } = await setup(t,{queueMs:150});
  const privateClient=await client(); const priv=await req(privateClient,'create_room',{name:'Private'});
  const a=await client(),b=await client();
  const qa=await req(a,'quick_play',{name:'Same'});
  assert.notEqual(qa.roomCode,priv.roomCode); assert.equal(qa.state.mode,'PUBLIC');
  assert.equal(qa.state.queueRemaining,null);
  const qb=await req(b,'quick_play',{name:'Same'});
  assert.equal(qb.roomCode,qa.roomCode); assert.equal(qb.state.players.length,2);
  assert.equal(qb.state.players[1].name,'Same #2');
  assert.equal((await req(a,'start_game')).ok,false);
  b.disconnect(); await until(()=>a.latest.players.length===1);
  assert.equal(server.rooms.get(qa.roomCode).queueDeadline,null);
  const c=await client(); await req(c,'quick_play',{name:'Third'});
  await until(()=>a.latest.phase==='DECISION');
  assert.ok(a.latest.players.every(p=>!p.isBot)); assert.equal(privateClient.latest.phase,'LOBBY');
});

test('practice starts immediately with two labeled bots, locks their decisions, and excludes strangers', async t => {
  const { client } = await setup(t,{botDelayMs:30});
  const a=await client();const r=await req(a,'practice',{name:'Pilot'});
  assert.equal(r.ok,true);assert.equal(r.state.mode,'PRACTICE');assert.equal(r.state.phase,'DECISION');
  assert.equal(r.state.players.filter(p=>p.isBot).length,2);
  await until(()=>a.latest.players.filter(p=>p.isBot).every(p=>p.hasLockedChoice));
  assert.ok(a.latest.players.filter(p=>p.isBot).every(p=>p.lastChoice===null));
  const b=await client();assert.equal((await req(b,'join_room',{name:'Intruder',roomCode:r.roomCode})).ok,false);
  await req(a,'submit_choice',{choice:'EXTRACT',turnId:a.latest.turnId});
  assert.ok(['TURN_SUMMARY','STORM_END'].includes(a.latest.phase));
});

test('practice fallback explicitly leaves public queue and bots do not keep abandoned rooms alive', async t => {
  const { server,client } = await setup(t,{emptyTtlMs:50});
  const a=await client();const queued=await req(a,'quick_play',{name:'Pilot'});
  const practice=await req(a,'practice',{name:'Pilot'});
  assert.notEqual(practice.roomCode,queued.roomCode);assert.equal(practice.state.mode,'PRACTICE');
  a.disconnect();await until(()=>!server.rooms.has(practice.roomCode));
});

test('preset reactions are scoped, rate-limited, and forbidden during games', async t => {
  const { client }=await setup(t);const {a,b}=await pair(client);
  const elsewhere=await client();await req(elsewhere,'create_room',{name:'Elsewhere'});
  assert.equal((await req(a,'react',{reaction:'<script>alert(1)</script>'})).ok,false);
  assert.equal((await req(a,'react',{reaction:'READY'})).ok,true);
  await until(()=>b.latest.reactions.length===1);
  assert.equal(b.latest.reactions[0].text,'Ready to chase!');assert.equal(elsewhere.latest.reactions.length,0);
  assert.equal((await req(a,'react',{reaction:'GG'})).ok,false);
  await req(a,'start_game');assert.equal((await req(b,'react',{reaction:'GG'})).ok,false);
});

test('session wins increment once per finished match, survive rematch, and restore on reconnect', async t => {
  const { client }=await setup(t,{decisionMs:50,summaryMs:20,stormEndMs:20});const {a,b,created}=await pair(client);
  await req(a,'start_game');await until(()=>a.latest.phase==='GAME_OVER');
  assert.deepEqual(a.latest.players.map(p=>p.sessionWins),[1,1]);
  a.disconnect();await until(()=>!b.latest.players[0].connected);
  const c=await client();const restored=await req(c,'resume_session',{roomCode:created.roomCode,token:created.token});
  assert.equal(restored.state.players[0].sessionWins,1);
  await req(b,'start_game');await until(()=>b.latest.phase==='DECISION');
  assert.deepEqual(b.latest.players.map(p=>p.sessionWins),[1,1]);
  await until(()=>b.latest.phase==='GAME_OVER');assert.deepEqual(b.latest.players.map(p=>p.sessionWins),[2,2]);
});
