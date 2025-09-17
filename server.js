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

// Helper: adjudicar al último pujador si es válido
function autoAwardIfPossible(code) {
  if (!rooms.has(code)) return;
  const room = rooms.get(code);
  if (!room || !room.current) return;
  const player = room.current.player;
  const bid = room.current.currentBid || 0;
  const winnerId = room.current.lastBidderId;
  if (!player || !winnerId) return;
  if (room.current.awarded) return;
  const min = player.price || 0;
  if (bid < min) return;
  const budget = room.budgets.get(winnerId) ?? 0;
  if (bid > budget) return;
  // Solo 1 compra por posición por usuario
  const pos = room.current.positionName;
  if (!room.winnersPerPosition.has(pos)) room.winnersPerPosition.set(pos, new Set());
  const winnersSet = room.winnersPerPosition.get(pos);
  if (winnersSet.has(winnerId)) return;
  // Descontar y notificar
  room.budgets.set(winnerId, budget - bid);
  io.to(code).emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
  // Garantizar revelación sincronizada en todos
  io.to(code).emit('player_revealed');
  io.to(code).emit('winner_confirmed', { winnerId, price: bid, player, positionName: room.current.positionName });
  // Actualizar equipo
  const team = room.teams.get(winnerId) || {};
  team[room.current.positionName] = { name: player.name, price: bid, photo: player.photo };
  room.teams.set(winnerId, team);
  io.to(code).emit('teams_update', { users: { [winnerId]: team } });
  winnersSet.add(winnerId);
  // Reset puja y marcar adjudicado
  room.current.currentBid = 0;
  room.current.lastBidderId = null;
  room.current.awarded = true;
  // Limpiar jugador actual y el temporizador
  room.current.player = null;
  if (room.current.timerHandle) { clearTimeout(room.current.timerHandle); room.current.timerHandle = null; }
  room.current.timerEndAt = null;
  // Actualizar elegibles de ruleta tras adjudicar
  try {
    const pos = room.current.positionName;
    const minAfter = Number(player?.price) || 0;
    const winnersSet2 = room.winnersPerPosition.get(pos) || new Set();
    const eligibles2 = Array.from(room.participants.keys()).filter(id => !winnersSet2.has(id) && (room.budgets.get(id) ?? 0) >= minAfter);
    io.to(code).emit('roulette_update', { count: eligibles2.length, positionName: pos });
  } catch (_) {}
}

io.on('connection', (socket) => {
  let joinedCode = null;

  // Crear sala (host)
  socket.on('create_room', ({ name, avatar } = {}) => {
    try {
      const code = generateCode();
      // Inicializar estructura de sala
      const room = {
        hostId: socket.id,
        participants: new Map(),
        budgets: new Map(),
        teams: new Map(),
        current: { positionName: '', rounds: 0, player: null, currentBid: 0, lastBidderId: null, awarded: false, timerHandle: null, timerEndAt: null, revealed: false },
        winnersPerPosition: new Map(),
        marketOpen: false,
      };
      rooms.set(code, room);
      // Registrar host como participante
      const displayName = (name && String(name).trim()) || 'Anfitrión';
      room.participants.set(socket.id, { id: socket.id, name: displayName, avatar });
      room.budgets.set(socket.id, 1100);
      room.teams.set(socket.id, {});
      // Unir socket a la sala
      socket.join(code);
      joinedCode = code;
      // Notificar al host y estado inicial
      socket.emit('room_created', { code, participants: participantsArray(room) });
      socket.emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
      socket.emit('market_state', { open: !!room.marketOpen, reason: 'init' });
      io.to(code).emit('participants_update', { code, participants: participantsArray(room) });
    } catch (e) {
      socket.emit('room_error', { message: 'No se pudo crear la sala. Intenta de nuevo.' });
    }
  });

  // Host sets the same budget for all participants (typically used in lobby)
  socket.on('set_all_budgets', ({ code, amount }) => {
    try {
      if (!code || !rooms.has(code)) return;
      const room = rooms.get(code);
      if (room.hostId !== socket.id) return; // only host can change budgets
      const v = Math.max(0, Number(amount) || 0);
      // apply to all known participants
      for (const id of room.participants.keys()) {
        room.budgets.set(id, v);
      }
      io.to(code).emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
    } catch(_) {}
  });

  // Cierre de ruleta sincronizado por host
  socket.on('roulette_close', ({ code }) => {
    try {
      if (!code || !rooms.has(code)) return;
      const room = rooms.get(code);
      if (room.hostId !== socket.id) return;
      io.to(code).emit('roulette_close');
    } catch(_) {}
  });

  // Transfer Offers: route offers between participants while market is open
  socket.on('transfer_offer', (offer) => {
    try {
      const { code, from, to } = offer || {};
      if (!code || !rooms.has(code)) return;
      const room = rooms.get(code);
      if (!room.marketOpen) return;
      if (!from || !to) return;
      // Solo permitir que el emisor sea el socket actual
      if (from !== socket.id) return;
      // Enviar la oferta a toda la sala para que todos vean el detalle (solo el destinatario podrá responder)
      io.to(code).emit('transfer_offer', offer);
    } catch(_) {}
  });

  socket.on('transfer_offer_update', ({ code, action, offer }) => {
    try {
      if (!code || !rooms.has(code)) return;
      const room = rooms.get(code);
      if (!offer) return;
      const from = offer.from;
      const to = offer.to;
      if (!from || !to) return;
      // Reenviar actualización a toda la sala (todos ven el resultado)
      io.to(code).emit('transfer_offer_update', { action, offer });
      // Si el destinatario acepta, ejecutar el intercambio de jugadores y dinero
      if (action === 'accept') {
        // Solo permitir mientras el mercado esté abierto
        if (!room.marketOpen) return;
        // Helpers locales
        function groupForPosition(posKey) {
          if (!posKey) return 'other';
          if (posKey === 'Portero') return 'gk';
          if (['Lateral Izquierdo','Central Izquierdo','Central Derecho','Lateral Derecho'].includes(posKey)) return 'def';
          if (['Mediocentro Defensivo','Mediocentro','Mediocentro Ofensivo'].includes(posKey)) return 'mid';
          if (['Extremo Izquierdo','Delantero Centro','Extremo Derecho'].includes(posKey)) return 'att';
          return 'other';
        }
        // Asegurar equipos y presupuestos
        if (!room.teams.has(from)) room.teams.set(from, {});
        if (!room.teams.has(to)) room.teams.set(to, {});
        const teamFrom = { ...(room.teams.get(from) || {}) };
        const teamTo = { ...(room.teams.get(to) || {}) };
        const budFrom = Number(room.budgets.get(from) ?? 0);
        const budTo = Number(room.budgets.get(to) ?? 0);
        // Dinero
        const cashMine = Math.max(0, Number(offer.cashMine) || 0); // dinero que ofrece 'from' al 'to'
        const cashTheirs = Math.max(0, Number(offer.cashTheirs) || 0); // dinero que ofrece 'to' al 'from'
        // Validar que 'from' tenga presupuesto suficiente para cashMine y 'to' para cashTheirs
        if (budFrom < cashMine || budTo < cashTheirs) {
          return; // inválido, no aplicar
        }
        // Procesar pares válidos, evitando duplicados de slots
        const pairs = Array.isArray(offer.pairs) ? offer.pairs : [];
        const usedFromSlots = new Set(); // mySlot (del emisor)
        const usedToSlots = new Set();   // opponentSlot (del receptor)
        let appliedAny = false;
        for (const p of pairs) {
          const oppSlot = p && p.opponentSlot; // slot del receptor
          const mySlot = p && p.mySlot;        // slot del emisor
          if (!oppSlot || !mySlot) continue;
          if (usedFromSlots.has(mySlot) || usedToSlots.has(oppSlot)) continue; // evitar duplicados
          // Validar grupos
          const gA = groupForPosition(oppSlot);
          const gB = groupForPosition(mySlot);
          if (gA !== gB) continue;
          const a = teamTo[oppSlot]; // jugador del receptor
          const b = teamFrom[mySlot]; // jugador del emisor
          if (!a || !b) continue; // ambos deben existir
          // Intercambiar
          teamTo[oppSlot] = b;
          teamFrom[mySlot] = a;
          usedFromSlots.add(mySlot);
          usedToSlots.add(oppSlot);
          appliedAny = true;
        }
        if (!appliedAny && cashMine === 0 && cashTheirs === 0) {
          return; // nada que aplicar
        }
        // Ajustar presupuestos
        const newBudFrom = budFrom - cashMine + cashTheirs;
        const newBudTo = budTo - cashTheirs + cashMine;
        if (newBudFrom < 0 || newBudTo < 0) return; // no permitir negativos
        room.budgets.set(from, newBudFrom);
        room.budgets.set(to, newBudTo);
        // Persistir equipos
        room.teams.set(from, teamFrom);
        room.teams.set(to, teamTo);
        // Notificar a todos en la sala los cambios (equipos y presupuestos)
        io.to(code).emit('teams_update', { users: { [from]: teamFrom, [to]: teamTo } });
        io.to(code).emit('budget_update', { budgets: Object.fromEntries(room.budgets) });
      }
    } catch(_) {}
  });

  // Revelación del jugador (salto o sync explícito) - solo host puede emitir
  socket.on('player_revealed', ({ code }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return;
    // marcar revelado para bloquear pujas futuras
    if (room.current) room.current.revealed = true;
    io.to(code).emit('player_revealed', { player: room.current.player, positionName: room.current.positionName });
  });

  // Sync Roulette Modal open/close (host only)
  socket.on('roulette_modal', ({ code, open }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return; // only host controls modal
    io.to(code).emit('roulette_modal', { open: !!open });
  });

  // Transfer Market state toggle (host only)
  socket.on('market_state', ({ code, open, reason }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return; // only host can toggle market state
    room.marketOpen = !!open;
    console.log(`[server] market_state -> code=${code} open=${room.marketOpen} reason=${reason || 'broadcast'} sender=${socket.id}`);
    io.to(code).emit('market_state', { open: !!room.marketOpen, reason: reason || 'broadcast' });
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
      // Sync del temporizador si está activo
      if (room.current.timerEndAt) {
        socket.emit('timer_update', { endAt: room.current.timerEndAt });
      }
    }
  });

  socket.on('start_game', ({ code }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return; // only host can start
    room.current = { positionName: '', rounds: 0, player: null, currentBid: 0, lastBidderId: null, awarded: false, timerHandle: null, timerEndAt: null, revealed: false };
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
    // Limpiar temporizador previo si existiera
    if (room.current.timerHandle) { clearTimeout(room.current.timerHandle); room.current.timerHandle = null; }
    room.current.timerEndAt = null;
    room.current.player = player;
    room.current.currentBid = 0;
    room.current.lastBidderId = null;
    room.current.awarded = false;
    room.current.revealed = false;
    io.to(code).emit('player_set', { player, index: Number(index) || 1, totalRounds: room.current.rounds, positionName: room.current.positionName });
    io.to(code).emit('bid_update', { currentBid: 0, bidderId: null });
    io.to(code).emit('timer_update', { endAt: null });
    // Actualizar elegibles para ruleta
    try {
      const min = Number(player?.price) || 0;
      const pos = room.current.positionName;
      const winnersSet = room.winnersPerPosition.get(pos) || new Set();
      const eligibles = Array.from(room.participants.keys()).filter(id => !winnersSet.has(id) && (room.budgets.get(id) ?? 0) >= min);
      io.to(code).emit('roulette_update', { count: eligibles.length, positionName: pos });
    } catch(_) {}
  });

  // Cualquier usuario puede pujar
  socket.on('place_bid', ({ code, value }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (!room.current || !room.current.player) return;
    if (room.current.revealed) return; // bloquear pujas tras la revelación
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
    // Iniciar/Reiniciar temporizador de 5s
    if (room.current.timerHandle) { clearTimeout(room.current.timerHandle); room.current.timerHandle = null; }
    const endAt = Date.now() + 5000;
    room.current.timerEndAt = endAt;
    room.current.timerHandle = setTimeout(() => {
      // Al expirar, adjudicar automáticamente si es válido
      autoAwardIfPossible(code);
    }, 5000);
    io.to(code).emit('timer_update', { endAt });
  });

  // Solo host confirma ganador
  socket.on('confirm_winner', ({ code }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return;
    // Limpiar temporizador si existiera
    if (room.current.timerHandle) { clearTimeout(room.current.timerHandle); room.current.timerHandle = null; }
    room.current.timerEndAt = null;
    // Revelar al jugador (si no se había revelado) para bloquear nuevas pujas
    room.current.revealed = true;
    io.to(code).emit('player_revealed', { player: room.current.player, positionName: room.current.positionName });
    // Reutilizar la lógica de adjudicación
    autoAwardIfPossible(code);
    // Emitir actualización de ruleta tras adjudicar
    if (rooms.has(code)) {
      const room = rooms.get(code);
      const pos = room.current.positionName;
      const min = Number(room.current.player?.price) || 0;
      const winnersSet = room.winnersPerPosition.get(pos) || new Set();
      const eligibles = Array.from(room.participants.keys()).filter(id => !winnersSet.has(id) && (room.budgets.get(id) ?? 0) >= min);
      io.to(code).emit('roulette_update', { count: eligibles.length, positionName: pos });
    }
  });

  // ===== Ruleta (solo host) =====
  socket.on('spin_roulette', ({ code }) => {
    if (!rooms.has(code)) return;
    const room = rooms.get(code);
    if (room.hostId !== socket.id) return; // solo el host
    // Debe haber jugador actual
    const player = room.current && room.current.player;
    if (!player) return;
    const pos = room.current.positionName;
    const min = Number(player.price) || 0;
    // Construir lista de elegibles: no han ganado en esta posición y tienen presupuesto suficiente
    const winnersSet = room.winnersPerPosition.get(pos) || new Set();
    const eligibles = Array.from(room.participants.keys()).filter(id => !winnersSet.has(id) && (room.budgets.get(id) ?? 0) >= min);
    io.to(code).emit('roulette_update', { count: eligibles.length, positionName: pos });
    if (eligibles.length === 0) return;
    // Elegir aleatorio
    const winnerId = eligibles[Math.floor(Math.random() * eligibles.length)];
    // Detener temporizador del conteo de puja si estaba activo
    if (room.current.timerHandle) { clearTimeout(room.current.timerHandle); room.current.timerHandle = null; }
    room.current.timerEndAt = null;
    io.to(code).emit('timer_update', { endAt: null });
    // Avisar a todos de la ruleta y el ganador seleccionado (esto abre/activa la animación en clientes)
    io.to(code).emit('roulette_spun', { winnerId, positionName: pos, price: min });
    // Tras finalizar la animación (~5.2s), fijar la puja mínima y adjudicar
    setTimeout(() => {
      if (!rooms.has(code)) return;
      const room2 = rooms.get(code);
      if (!room2 || !room2.current || !room2.current.player) return;
      // Si cambió de jugador/posición en el ínterin, no continuar
      const samePos = room2.current.positionName === pos;
      if (!samePos) return;
      room2.current.currentBid = min;
      room2.current.lastBidderId = winnerId;
      io.to(code).emit('bid_update', { currentBid: min, bidderId: winnerId });
      // Adjudicar usando la lógica existente (emitirá player_revealed y winner_confirmed)
      autoAwardIfPossible(code);
      // Actualizar elegibles post-adjudicación
      if (rooms.has(code)) {
        const room3 = rooms.get(code);
        const winnersSetAfter = room3.winnersPerPosition.get(pos) || new Set();
        const eligiblesAfter = Array.from(room3.participants.keys()).filter(id => !winnersSetAfter.has(id) && (room3.budgets.get(id) ?? 0) >= min);
        io.to(code).emit('roulette_update', { count: eligiblesAfter.length, positionName: pos });
      }
    }, 5200);
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
