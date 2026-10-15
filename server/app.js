import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { makeRoom, beginStorm, revealCard, lockChoice, resolveChoices, snapshot, activePlayers } from './game.js';

export function createGameServer(options = {}) {
  const decisionMs = options.decisionMs ?? 15_000;
  const summaryMs = options.summaryMs ?? 2_000;
  const stormEndMs = options.stormEndMs ?? 3_000;
  const emptyTtlMs = options.emptyTtlMs ?? 120_000;
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 4096,
    allowRequest(req, done) {
      const origin = req.headers.origin;
      try { done(null, !origin || (options.publicOrigin ? origin === options.publicOrigin : new URL(origin).host === req.headers.host)); }
      catch { done(null, false); }
    },
  });
  const rooms = new Map();
  const emit = room => io.to(room.roomCode).emit('state_update', snapshot(room));
  function arm(room) {
    const delay = { DECISION: decisionMs, TURN_SUMMARY: summaryMs, STORM_END: stormEndMs }[room.phase];
    room.deadline = delay ? Date.now() + delay : null;
    room.lastCountdown = snapshot(room).timerRemaining;
    emit(room);
  }
  function resolve(room) { resolveChoices(room); arm(room); }
  function hostTransfer(room) {
    if (room.players.some(p => p.isHost && p.connected)) return;
    const next = room.players.find(p => p.connected);
    if (next) for (const p of room.players) p.isHost = p === next;
  }
  function disconnected(socket, leaving = false) {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.find(p => p.id === socket.data.playerId);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    if (leaving) {
      p.token = null;
      if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') room.players = room.players.filter(x => x !== p);
    }
    hostTransfer(room);
    if (!room.players.some(p => p.connected)) room.emptySince ??= Date.now();
    emit(room);
    socket.leave(room.roomCode);
    socket.data.roomCode = null;
    socket.data.playerId = null;
  }
  function code() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let value;
    do { value = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(value));
    return value;
  }
  function name(value) {
    if (typeof value !== 'string') throw new Error('Enter a crew name.');
    const clean = value.trim().replace(/[\x00-\x1f\x7f]/g, '');
    if (!clean || clean.length > 20) throw new Error('Use a crew name of 1–20 characters.');
    return clean;
  }
  function attach(socket, room, player) {
    player.connected = true;
    player.socketId = socket.id;
    room.emptySince = null;
    socket.data.roomCode = room.roomCode;
    socket.data.playerId = player.id;
    socket.join(room.roomCode);
    hostTransfer(room);
    emit(room);
    return { playerId: player.id, token: player.token, roomCode: room.roomCode,
      state: snapshot(room), ownChoice: room.choices.get(player.id) ?? null };
  }
  io.on('connection', socket => {
    let windowStart = Date.now(), requests = 0;
    const on = (event, handler) => socket.on(event, (payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (Date.now() - windowStart > 10_000) { windowStart = Date.now(); requests = 0; }
        if (++requests > 40) throw new Error('Too many requests. Wait a few seconds.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid request.');
        ack({ ok: true, ...handler(payload) });
      } catch (error) { ack({ ok: false, error: error.message }); }
    });
    function unbound() { if (socket.data.roomCode) throw new Error('Leave your current room first.'); }
    function member() {
      const room = rooms.get(socket.data.roomCode);
      const player = room?.players.find(p => p.id === socket.data.playerId && p.socketId === socket.id);
      if (!player) throw new Error('Join a room first.');
      return { room, player };
    }
    function newPlayer(playerName, isHost) {
      return { id: randomUUID(), token: randomBytes(32).toString('hex'), name: name(playerName),
        isHost, connected: true, status: 'ACTIVE', unbankedScore: 0, bankedScore: 0, lastChoice: null };
    }
    on('create_room', data => {
      unbound();
      if (rooms.size >= (options.maxRooms ?? 500)) throw new Error('Server is full. Try again later.');
      const p = newPlayer(data.name, true), room = makeRoom(code());
      room.players.push(p); rooms.set(room.roomCode, room);
      return attach(socket, room, p);
    });
    on('join_room', data => {
      unbound();
      const room = rooms.get(String(data.roomCode).trim().toUpperCase());
      if (!room) throw new Error('Room not found. Check the four-letter code.');
      if (room.phase !== 'LOBBY') throw new Error('This game has already started.');
      if (room.players.length >= 8) throw new Error('This room is full (8 crews).');
      const p = newPlayer(data.name, false);
      if (room.players.some(x => x.name.toLowerCase() === p.name.toLowerCase())) throw new Error('That crew name is taken.');
      room.players.push(p);
      return attach(socket, room, p);
    });
    on('resume_session', data => {
      unbound();
      const room = rooms.get(data.roomCode);
      const p = typeof data.token === 'string' && room?.players.find(x => x.token === data.token);
      if (!p) throw new Error('Session expired. Create or join a room.');
      if (p.connected) throw new Error('This session is open in another tab.');
      return attach(socket, room, p);
    });
    on('start_game', () => {
      const { room, player } = member();
      if (!player.isHost) throw new Error('Only the host can launch.');
      if (!['LOBBY', 'GAME_OVER'].includes(room.phase)) throw new Error('Game already in progress.');
      if (room.players.filter(p => p.connected).length < 2) throw new Error('At least two connected crews are needed.');
      room.players = room.players.filter(p => p.connected);
      room.stormNumber = 0;
      for (const p of room.players) p.bankedScore = 0;
      beginStorm(room); arm(room);
      return {};
    });
    on('submit_choice', data => {
      const { room, player } = member();
      if (room.phase === 'DECISION' && Date.now() >= room.deadline) resolve(room);
      lockChoice(room, player, data.choice, data.turnId);
      if (activePlayers(room).every(p => room.choices.has(p.id))) resolve(room);
      else emit(room);
      return {};
    });
    on('leave_room', () => { disconnected(socket, true); return {}; });
    socket.on('disconnect', () => disconnected(socket));
  });
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.emptySince !== null && now - room.emptySince >= emptyTtlMs) {
        rooms.delete(room.roomCode); continue;
      }
      if (room.deadline && now >= room.deadline) {
        if (room.phase === 'DECISION') resolveChoices(room);
        else if (room.phase === 'TURN_SUMMARY') revealCard(room);
        else if (room.phase === 'STORM_END') {
          if (room.stormNumber >= room.maxStorms) {
            room.phase = 'GAME_OVER'; room.lastEventLog = 'Three storms complete. Highest banked score wins; ties share victory.';
          } else beginStorm(room);
        }
        arm(room);
      } else if (room.deadline) {
        const remaining = snapshot(room, now).timerRemaining;
        if (remaining !== room.lastCountdown) { room.lastCountdown = remaining; emit(room); }
      }
    }
  }, options.tickMs ?? 100);
  ticker.unref();
  return { app, httpServer, io, rooms,
    listen: (port = 3000, host = '0.0.0.0') => new Promise(resolve => httpServer.listen(port, host, resolve)),
    close: () => new Promise(resolve => { clearInterval(ticker); io.close(resolve); }),
  };
}
