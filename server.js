
"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const CAPACITY = Math.max(2, Math.min(16, Number(process.env.ROOM_CAPACITY) || 8));
const ARENA = 40;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, game: "NEON FRONTIER PRO" }));

const rooms = new Map();
const players = new Map();
const shots = new Map();

const COLORS = [
  "#55e7ff", "#ff4f9a", "#a78bfa", "#facc15",
  "#4ade80", "#fb923c", "#60a5fa", "#f472b6"
];

function cleanName(value) {
  return String(value || "Ranger")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 16) || "Ranger";
}

function cleanCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function defaultSettings() {
  return {
    mode: "infinity",
    lives: 5,
    timeLimit: 0,
    killLimit: 0,
    damage: 25
  };
}

function spawnPoint() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 4 + Math.random() * 14;
  return {
    x: Math.round(Math.cos(angle) * radius * 100) / 100,
    z: Math.round(Math.sin(angle) * radius * 100) / 100
  };
}

function safePlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    z: p.z,
    rot: p.rot,
    color: p.color,
    hp: p.hp,
    score: p.score,
    deaths: p.deaths,
    livesLeft: p.livesLeft,
    alive: p.alive,
    ready: p.ready
  };
}

function getRoomPlayers(code) {
  const room = rooms.get(code);
  if (!room) return [];
  return [...room.players]
    .map(id => players.get(id))
    .filter(Boolean)
    .map(safePlayer);
}

function getPublicSettings(room) {
  return {
    ...room.settings,
    capacity: CAPACITY,
    hostId: room.hostId,
    phase: room.phase,
    secondsLeft: room.secondsLeft
  };
}

function sendRoomInfo(code) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit("roomInfo", {
    code,
    hostId: room.hostId,
    capacity: CAPACITY,
    phase: room.phase,
    settings: getPublicSettings(room),
    players: getRoomPlayers(code)
  });

  io.to(code).emit("roomSettingsUpdated", getPublicSettings(room));
  sendLeaderboard(code);
}

function sendLeaderboard(code) {
  const room = rooms.get(code);
  if (!room) return;

  const list = getRoomPlayers(code)
    .sort((a, b) => b.score - a.score)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      deaths: p.deaths,
      livesLeft: p.livesLeft
    }));

  io.to(code).emit("leaderboard", list);
}

function emitMatchStatus(room) {
  io.to(room.code).emit("matchStatus", {
    status: room.phase,
    secondsLeft: room.secondsLeft,
    settings: getPublicSettings(room)
  });
}

function fail(socket, message) {
  socket.emit("roomError", message);
}

function settingsFail(socket, message) {
  socket.emit("settingsError", message);
}

function removeOwnedShots(id, code) {
  for (const [shotId, shot] of shots) {
    if (shot.owner === id && shot.room === code) {
      shots.delete(shotId);
      io.to(code).emit("shotRemove", shotId);
    }
  }
}

function removeFromRoom(socket) {
  const p = players.get(socket.id);
  if (!p) return;

  const code = p.room;
  const room = rooms.get(code);

  socket.leave(code);
  players.delete(socket.id);
  removeOwnedShots(socket.id, code);

  if (!room) return;

  room.players.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.values().next().value;
  }

  io.to(code).emit("playerLeft", socket.id);

  if (room.phase === "playing" && room.players.size < 2) {
    endMatch(room, null, "Pemain tidak cukup untuk melanjutkan.");
  }

  sendRoomInfo(code);
}

function enterRoom(socket, room, name) {
  if (!room) return fail(socket, "Room tidak ditemukan.");
  if (room.players.size >= CAPACITY) return fail(socket, "Room sudah penuh.");
  if (players.has(socket.id)) return fail(socket, "Kamu sudah berada di room.");
  if (room.phase !== "lobby") return fail(socket, "Pertandingan sudah dimulai.");

  const pos = spawnPoint();
  const p = {
    id: socket.id,
    room: room.code,
    name: cleanName(name),
    x: pos.x,
    z: pos.z,
    rot: 0,
    color: COLORS[room.players.size % COLORS.length],
    hp: 100,
    score: 0,
    deaths: 0,
    livesLeft: room.settings.lives,
    alive: true,
    ready: false,
    lastMove: 0,
    lastShot: 0,
    respawnAt: 0
  };

  players.set(socket.id, p);
  room.players.add(socket.id);
  socket.join(room.code);

  socket.emit("welcome", {
    id: socket.id,
    roomCode: room.code,
    player: safePlayer(p),
    arena: ARENA
  });

  socket.emit("world", {
    players: getRoomPlayers(room.code).filter(q => q.id !== socket.id),
    shots: [...shots.values()].filter(s => s.room === room.code)
  });

  socket.to(room.code).emit("playerJoined", safePlayer(p));
  sendRoomInfo(room.code);
}

function startMatch(room) {
  if (!room || room.phase !== "lobby") return false;

  const active = [...room.players]
    .map(id => players.get(id))
    .filter(Boolean);

  if (active.length < 1) return false;

  room.phase = "playing";
  room.startedAt = Date.now();
  room.endsAt = room.settings.timeLimit > 0
    ? Date.now() + room.settings.timeLimit * 60000
    : 0;
  room.secondsLeft = room.settings.timeLimit * 60;

  for (const p of active) {
    p.score = 0;
    p.deaths = 0;
    p.hp = 100;
    p.livesLeft = room.settings.lives;
    p.alive = true;
    p.ready = false;
    p.respawnAt = 0;

    const pos = spawnPoint();
    p.x = pos.x;
    p.z = pos.z;
  }

  io.to(room.code).emit("matchStarted", {
    settings: getPublicSettings(room),
    players: getRoomPlayers(room.code)
  });

  sendRoomInfo(room.code);
  emitMatchStatus(room);
  return true;
}

function endMatch(room, winnerId, reason) {
  if (!room || room.phase !== "playing") return;

  room.phase = "ended";
  room.secondsLeft = 0;

  const winner = winnerId ? players.get(winnerId) : null;
  io.to(room.code).emit("matchEnded", {
    winnerId: winnerId || null,
    winnerName: winner ? winner.name : "Tidak ada pemenang",
    reason: reason || "Pertandingan selesai",
    leaderboard: getRoomPlayers(room.code)
      .sort((a, b) => b.score - a.score)
  });

  emitMatchStatus(room);
  sendRoomInfo(room.code);
}

function checkWin(room) {
  if (!room || room.phase !== "playing") return;

  if (room.settings.killLimit > 0) {
    const winner = [...room.players]
      .map(id => players.get(id))
      .filter(Boolean)
      .find(p => p.score >= room.settings.killLimit);

    if (winner) endMatch(room, winner.id, "Target kill tercapai.");
  }

  if (room.settings.mode === "lives") {
    const alivePlayers = [...room.players]
      .map(id => players.get(id))
      .filter(p => p && p.livesLeft > 0);

    const allPlayers = [...room.players]
      .map(id => players.get(id))
      .filter(Boolean);

    if (allPlayers.length >= 2 && alivePlayers.length <= 1) {
      endMatch(room, alivePlayers[0]?.id || null, "Mode Limited Lives selesai.");
    }
  }
}

io.on("connection", socket => {
  socket.on("createRoom", data => {
    if (players.has(socket.id)) {
      return fail(socket, "Keluar dari room saat ini terlebih dahulu.");
    }

    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Set(),
      settings: defaultSettings(),
      phase: "lobby",
      startedAt: 0,
      endsAt: 0,
      secondsLeft: 0
    };

    rooms.set(code, room);
    enterRoom(socket, room, data && data.name);
  });

  socket.on("joinRoom", data => {
    if (players.has(socket.id)) {
      return fail(socket, "Kamu sudah berada di room.");
    }

    const code = cleanCode(data && data.code);
    if (code.length !== 6) {
      return fail(socket, "Kode room harus terdiri dari 6 karakter.");
    }

    enterRoom(socket, rooms.get(code), data && data.name);
  });

  socket.on("leaveRoom", () => {
    removeFromRoom(socket);
    socket.emit("roomLeft");
  });

  socket.on("setReady", value => {
    const p = players.get(socket.id);
    const room = p && rooms.get(p.room);
    if (!p || !room || room.phase !== "lobby") return;

    p.ready = Boolean(value);
    sendRoomInfo(room.code);
  });

  socket.on("updateRoomSettings", data => {
    const p = players.get(socket.id);
    const room = p && rooms.get(p.room);

    if (!p || !room) return settingsFail(socket, "Kamu belum berada di room.");
    if (room.hostId !== socket.id) return settingsFail(socket, "Hanya host yang boleh mengatur room.");
    if (room.phase !== "lobby") return settingsFail(socket, "Pengaturan hanya bisa diubah saat lobby.");
    if (!data || typeof data !== "object") return settingsFail(socket, "Pengaturan tidak valid.");

    const mode = data.mode === "lives" ? "lives" : "infinity";
    const lives = Number(data.lives);
    const timeLimit = Number(data.timeLimit);
    const killLimit = Number(data.killLimit);
    const damage = Number(data.damage);

    if (![3, 5, 10].includes(lives)) return settingsFail(socket, "Jumlah nyawa tidak valid.");
    if (![0, 5, 10, 15, 30].includes(timeLimit)) return settingsFail(socket, "Durasi tidak valid.");
    if (![0, 5, 10, 20, 30].includes(killLimit)) return settingsFail(socket, "Target kill tidak valid.");
    if (![10, 25, 50, 100].includes(damage)) return settingsFail(socket, "Damage tidak valid.");

    room.settings = { mode, lives, timeLimit, killLimit, damage };

    for (const id of room.players) {
      const player = players.get(id);
      if (player) player.livesLeft = lives;
    }

    sendRoomInfo(room.code);
  });

  socket.on("startMatch", () => {
    const p = players.get(socket.id);
    const room = p && rooms.get(p.room);

    if (!p || !room) return settingsFail(socket, "Kamu belum berada di room.");
    if (room.hostId !== socket.id) return settingsFail(socket, "Hanya host yang dapat memulai pertandingan.");
    if (!startMatch(room)) return settingsFail(socket, "Tidak bisa memulai pertandingan.");
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !p.room || !data || !p.alive) return;

    const room = rooms.get(p.room);
    if (!room || room.phase !== "playing") return;

    const now = Date.now();
    if (now - p.lastMove < 30) return;

    const x = Number(data.x);
    const z = Number(data.z);
    const rot = Number(data.rot);
    if (![x, z, rot].every(Number.isFinite)) return;
    if (Math.abs(x) > ARENA + 3 || Math.abs(z) > ARENA + 3) return;

    p.lastMove = now;
    p.x = Math.max(-ARENA + 2, Math.min(ARENA - 2, x));
    p.z = Math.max(-ARENA + 2, Math.min(ARENA - 2, z));
    p.rot = Math.max(-Math.PI * 8, Math.min(Math.PI * 8, rot));

    socket.to(p.room).emit("playerMoved", safePlayer(p));
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    const room = p && rooms.get(p.room);
    if (!p || !room || room.phase !== "playing" || !p.alive || !data) return;

    const now = Date.now();
    if (now - p.lastShot < 250) return;

    const dx = Number(data.dx);
    const dz = Number(data.dz);
    if (![dx, dz].every(Number.isFinite)) return;

    const length = Math.hypot(dx, dz);
    if (length < 0.7 || length > 1.3) return;

    p.lastShot = now;

    const shot = {
      id: `${socket.id}-${now}-${Math.random().toString(36).slice(2, 7)}`,
      owner: socket.id,
      room: p.room,
      x: p.x,
      z: p.z,
      dx: dx / length,
      dz: dz / length,
      born: now,
      color: p.color
    };

    shots.set(shot.id, shot);
    io.to(p.room).emit("shotSpawn", shot);
  });

  socket.on("disconnect", () => removeFromRoom(socket));
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.phase === "playing") {
      if (room.endsAt > 0) {
        room.secondsLeft = Math.max(0, Math.ceil((room.endsAt - now) / 1000));
        if (now >= room.endsAt) {
          const winner = [...room.players]
            .map(id => players.get(id))
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)[0];
          endMatch(room, winner ? winner.id : null, "Waktu pertandingan habis.");
          continue;
        }
      }

      for (const id of room.players) {
        const p = players.get(id);
        if (!p || p.alive || !p.respawnAt || now < p.respawnAt) continue;

        p.respawnAt = 0;
        if (room.settings.mode === "lives" && p.livesLeft <= 0) continue;

        const pos = spawnPoint();
        p.x = pos.x;
        p.z = pos.z;
        p.hp = 100;
        p.alive = true;
        io.to(room.code).emit("playerRespawn", safePlayer(p));
      }

      emitMatchStatus(room);
    }
  }

  for (const [id, shot] of shots) {
    const room = rooms.get(shot.room);
    const owner = players.get(shot.owner);

    if (!room || room.phase !== "playing" || !owner || now - shot.born > 1400) {
      shots.delete(id);
      if (room) io.to(shot.room).emit("shotRemove", id);
      continue;
    }

    const age = (now - shot.born) / 1000;
    const sx = shot.x + shot.dx * age * 22;
    const sz = shot.z + shot.dz * age * 22;
    let consumed = false;

    for (const targetId of room.players) {
      const target = players.get(targetId);
      if (!target || !target.alive || target.id === owner.id) continue;

      if (Math.hypot(sx - target.x, sz - target.z) < 0.95) {
        shots.delete(id);
        io.to(room.code).emit("shotRemove", id);

        target.hp = Math.max(0, target.hp - room.settings.damage);
        io.to(room.code).emit("playerHit", {
          target: target.id,
          hp: target.hp,
          by: owner.id,
          shotId: id
        });

        if (target.hp <= 0) {
          target.alive = false;
          target.deaths += 1;
          target.respawnAt = now + 2200;

          if (room.settings.mode === "lives") {
            target.livesLeft = Math.max(0, target.livesLeft - 1);
          }

          owner.score += 1;

          io.to(room.code).emit("playerDown", {
            id: target.id,
            by: owner.id,
            score: owner.score,
            livesLeft: target.livesLeft
          });

          io.to(room.code).emit("playerMoved", safePlayer(target));
          sendLeaderboard(room.code);
          checkWin(room);
        }

        consumed = true;
        break;
      }
    }

    if (consumed) continue;
  }
}, 50);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NEON FRONTIER PRO running on port ${PORT}`);
});
