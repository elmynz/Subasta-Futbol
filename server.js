const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

// Serve static files (so you can open homE1.0.html from http://localhost:3000/homE1.0.html)
app.use(express.static(__dirname));

// Photo manifest endpoint to inform frontend of available player images
const fs = require('fs');
app.get('/photo-manifest', (req, res) => {
  try {
    const dir = path.join(__dirname, 'Fotos');
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => `Fotos/${d.name}`);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ files: [], error: String(e) });
  }
});

// Simple in-memory room store
// rooms: {
//   CODE: {
//     hostId: string,
//     participants: Map<socketId, {id, name, avatar}>,
//     budgets: Map<socketId, number>,
//     current: {
//       positionName: string,
//       rounds: number,
//       player: { name, price, photo, clues? } | null,
//       currentBid: number,
//       lastBidderId: string | null
//     }
//   }
// }
const rooms = new Map();

function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function participantsArray(room) {
  return Array.from(room.participants.values());
}

io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('create_room', ({ name, avatar }) => {
    let code = generateCode();
    while (rooms.has(code)) code = generateCode();
    const room = {
      hostId: socket.id,
      participants: new Map(),
      budgets: new Map(),
      current: { positionName: '', rounds: 0, player: null, currentBid: 0, lastBidderId: null, awarded: false },
      marketOpen: false,
      teams: new Map(), // socketId -> { positionKey: {name, price, photo} | null }
      winnersPerPosition: new Map(), // positionName -> Set(socketId)
    };
    room.participants.set(socket.id, { id: socket.id, name: name || 'Jugador', avatar });
    room.budgets.set(socket.id, 1100);
    room.teams.set(socket.id, {});
    rooms.set(code, room);
    socket.join(code);
    joinedCode = code;
    socket.emit('room_created', { code, participants: participantsArray(room) });
    io.to(code).emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
    io.to(code).emit('participants_update', { code, participants: participantsArray(room) });
  });

  // ===== Mercado de fichajes =====
  // Broadcast del estado del mercado (solo host)
  socket.on('market_state', ({ code, open, reason }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return;
    room.marketOpen = !!open;
    console.log(`[market_state] code=${code} host=${socket.id} open=${room.marketOpen} reason=${reason}`);
    io.to(code).emit('market_state', { open: room.marketOpen, reason: reason || '' });
  });

  // Relay de ofertas de intercambio
  socket.on('transfer_offer', (payload) => {
    const { code, from, to } = payload || {};
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (!room.participants.has(from) || !room.participants.has(to)) return;
    // Entregar directamente a emisor y receptor
    console.log(`[transfer_offer] code=${code} from=${from} to=${to}`);
    io.to(from).emit('transfer_offer', payload);
    io.to(to).emit('transfer_offer', payload);
    // Fallback de sala para asegurar visibilidad si IDs cambian por reconexión
    io.to(code).emit('transfer_offer', payload);
  });

  // Relay de actualización de oferta (aceptar/rechazar/contraofertar)
  socket.on('transfer_offer_update', (payload) => {
    const { code, offer } = payload || {};
    if (!rooms.has(code)) return;
    // Notificar solo a las dos partes
    console.log(`[transfer_offer_update] code=${code} action=${payload?.action} from=${offer?.from} to=${offer?.to}`);
    if (offer && offer.from) io.to(offer.from).emit('transfer_offer_update', payload);
    if (offer && offer.to) io.to(offer.to).emit('transfer_offer_update', payload);
    // Fallback de sala
    io.to(code).emit('transfer_offer_update', payload);
    // Si se acepta la oferta, aplicar el intercambio y actualizar presupuestos
    if (payload?.action === 'accept' && offer) {
      const room = rooms.get(code);
      const fromId = offer.from;
      const toId = offer.to;
      if (!room.participants.has(fromId) || !room.participants.has(toId)) return;
      const teams = room.teams;
      const teamFrom = teams.get(fromId) || {};
      const teamTo = teams.get(toId) || {};
      // Validar efectivo
      const cashMine = Math.max(0, Number(offer.cashMine) || 0); // dinero que paga el oferente
      const cashTheirs = Math.max(0, Number(offer.cashTheirs) || 0); // dinero que pide al receptor
      const budFrom = room.budgets.get(fromId) ?? 0;
      const budTo = room.budgets.get(toId) ?? 0;
      // El oferente no puede ofrecer más de lo que tiene
      if (cashMine > budFrom) return;
      // El receptor no puede pagar más de lo que tiene
      if (cashTheirs > budTo) return;
      // Validar pares y que existan jugadores en esos slots
      const pairs = Array.isArray(offer.pairs) ? offer.pairs : [];
      for (const p of pairs) {
        if (!p || !p.opponentSlot || !p.mySlot) return;
        if (!teamTo[p.opponentSlot] || !teamFrom[p.mySlot]) return;
      }
      // Aplicar swaps
      for (const p of pairs) {
        const a = teamTo[p.opponentSlot]; // del receptor
        const b = teamFrom[p.mySlot]; // del oferente
        teamTo[p.opponentSlot] = b;
        teamFrom[p.mySlot] = a;
      }
      teams.set(fromId, teamFrom);
      teams.set(toId, teamTo);
      // Aplicar efectivo
      const newBudFrom = budFrom - cashMine + cashTheirs;
      const newBudTo = budTo + cashMine - cashTheirs;
      if (newBudFrom < 0 || newBudTo < 0) return; // seguridad
      room.budgets.set(fromId, newBudFrom);
      room.budgets.set(toId, newBudTo);
      // Notificar cambios
      io.to(code).emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
      io.to(code).emit('teams_update', { users: { [fromId]: teamFrom, [toId]: teamTo } });
    }
  });

  // Revelación del jugador (salto o sync explícito) - solo host puede emitir
  socket.on('player_revealed', ({ code }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return;
    io.to(code).emit('player_revealed', { player: room.current.player, positionName: room.current.positionName });
  });

  socket.on('join_room', ({ code, name, avatar }) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms.has(code)) {
      socket.emit('room_error', { message: 'La sala no existe.' });
      return;
    }
    const room = rooms.get(code);
    // Validar avatar único en la sala (no permitir duplicados)
    if (avatar) {
      for (const p of room.participants.values()) {
        if (p && p.avatar === avatar) {
          socket.emit('room_error', { message: 'El avatar seleccionado ya está en uso en esta sala. Elige otro.' });
          return;
        }
      }
    }
    room.participants.set(socket.id, { id: socket.id, name: name || 'Jugador', avatar });
    if (!room.budgets.has(socket.id)) room.budgets.set(socket.id, 1100);
    if (!room.teams.has(socket.id)) room.teams.set(socket.id, {});
    socket.join(code);
    joinedCode = code;
    socket.emit('room_joined', { code, participants: participantsArray(room) });
    socket.emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
    // Sincronizar estado del mercado al recién llegado
    socket.emit('market_state', { open: !!room.marketOpen, reason: 'sync' });
    io.to(code).emit('participants_update', { code, participants: participantsArray(room) });
    // Si hay un jugador en curso, sincronizar al que entra
    if (room.current && room.current.player) {
      // avisar que el juego está en curso para que salga del lobby
      socket.emit('game_started', { code });
      socket.emit('round_set', { positionName: room.current.positionName, rounds: room.current.rounds });
      socket.emit('player_set', { player: room.current.player });
      if (room.current.currentBid > 0) {
        socket.emit('bid_update', { currentBid: room.current.currentBid, bidderId: room.current.lastBidderId });
      }
    }
  });

  socket.on('start_game', ({ code }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return; // only host can start
    room.current = { positionName: '', rounds: 0, player: null, currentBid: 0, lastBidderId: null, awarded: false };
    room.winnersPerPosition = new Map();
    io.to(code).emit('game_started', { code });
  });

  // Host define la ronda/posición actual
  socket.on('set_round', ({ code, positionName, rounds }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return;
    room.current.positionName = positionName;
    room.current.rounds = rounds || 0;
    // Ensure winners map has entry for this position
    if (!room.winnersPerPosition.has(positionName)) room.winnersPerPosition.set(positionName, new Set());
    io.to(code).emit('round_set', { positionName: room.current.positionName, rounds: room.current.rounds });
  });

  // Host define el jugador actual
  socket.on('set_player', ({ code, player, index }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return;
    room.current.player = player;
    room.current.currentBid = 0;
    room.current.lastBidderId = null;
    room.current.awarded = false;
    io.to(code).emit('player_set', { player, index: Number(index) || 1, totalRounds: room.current.rounds, positionName: room.current.positionName });
    io.to(code).emit('bid_update', { currentBid: 0, bidderId: null });
  });

  // Cualquier usuario puede pujar
  socket.on('place_bid', ({ code, value }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (!room.current || !room.current.player) return;
    const player = room.current.player;
    const budget = room.budgets.get(socket.id) ?? 0;
    const currentBid = room.current.currentBid || 0;
    const min = player.price || 0;
    // Block if this user already won a player for this position
    const winnersSet = room.winnersPerPosition.get(room.current.positionName) || new Set();
    if (winnersSet.has(socket.id)) return;
    const minAllowed = currentBid > 0 ? currentBid + 5 : min;
    let v = Number(value);
    if (!Number.isFinite(v)) return;
    if (v % 5 !== 0) v = Math.round(v / 5) * 5;
    if (v < minAllowed) return;
    if (v > budget) return;
    room.current.currentBid = v;
    room.current.lastBidderId = socket.id;
    io.to(code).emit('bid_update', { currentBid: v, bidderId: socket.id });
  });

  // Solo host confirma ganador
  socket.on('confirm_winner', ({ code }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return;
    const player = room.current.player;
    const bid = room.current.currentBid || 0;
    const winnerId = room.current.lastBidderId;
    if (!player || !winnerId) return;
    if (room.current.awarded) return; // prevent duplicate awards
    const min = player.price || 0;
    if (bid < min) return;
    const budget = room.budgets.get(winnerId) ?? 0;
    if (bid > budget) return;
    // Enforce one purchase per position per user
    const pos = room.current.positionName;
    if (!room.winnersPerPosition.has(pos)) room.winnersPerPosition.set(pos, new Set());
    const winnersSet = room.winnersPerPosition.get(pos);
    if (winnersSet.has(winnerId)) return; // already has a purchase in this position
    // Descontar
    room.budgets.set(winnerId, budget - bid);
    io.to(code).emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
    // Garantizar revelación sincronizada en todos
    io.to(code).emit('player_revealed');
    io.to(code).emit('winner_confirmed', { winnerId, price: bid, player, positionName: room.current.positionName });
    // Actualizar equipo del ganador en el servidor y notificar
    const team = room.teams.get(winnerId) || {};
    team[room.current.positionName] = { name: player.name, price: bid, photo: player.photo };
    room.teams.set(winnerId, team);
    io.to(code).emit('teams_update', { users: { [winnerId]: team } });
    winnersSet.add(winnerId);
    // Reset puja para el siguiente
    room.current.currentBid = 0;
    room.current.lastBidderId = null;
    room.current.awarded = true;
    // Evitar nuevas confirmaciones sobre el mismo jugador
    room.current.player = null;
  });

  socket.on('disconnect', () => {
    if (!joinedCode) return;
    const code = joinedCode;
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    room.participants.delete(socket.id);
    room.budgets.delete(socket.id);
    if (room.participants.size === 0) {
      rooms.delete(code);
      return;
    }
    // If host left, reassign host to the first remaining participant
    if (room.hostId === socket.id) {
      const first = room.participants.keys().next().value;
      room.hostId = first;
      io.to(code).emit('host_changed', { code, hostId: room.hostId });
    }
    io.to(code).emit('participants_update', { code, participants: participantsArray(room) });
    io.to(code).emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
