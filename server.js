
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
const ROOM_CAPACITY = Math.max(
  2,
  Math.min(16, Number(process.env.ROOM_CAPACITY) || 8)
);
const ARENA = 42;
const COLORS = [
  "#55e7ff", "#ff4f9a", "#a78bfa", "#facc15",
  "#4ade80", "#fb923c", "#60a5fa", "#f472b6"
];

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) =>
  res.json({ ok: true, game: "NEON FRONTIER" })
);

const rooms = new Map();
const players = new Map();
const shots = new Map();

function cleanName(value) {
  return String(value || "Ranger")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 16) || "Ranger";
}

function cleanCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function spawnPoint() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 5 + Math.random() * 12;
  return {
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: 0,
    z: p.z,
    rot: p.rot,
    color: p.color,
    hp: p.hp,
    score: p.score,
    deaths: p.deaths,
    moving: p.moving,
    alive: p.alive
  };
}

function roomPlayers(code) {
  const room = rooms.get(code);
  if (!room) return [];
  return [...room.players]
    .map(id => players.get(id))
    .filter(Boolean)
    .map(publicPlayer);
}

function sendRoomInfo(code) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit("roomInfo", {
    code,
    hostId: room.hostId,
    capacity: ROOM_CAPACITY,
    players: roomPlayers(code)
  });
}

function removePlayerFromRoom(socket, { announce = true } = {}) {
  const p = players.get(socket.id);
  if (!p) return;

  const code = p.room;
  if (!code) {
    players.delete(socket.id);
    return;
  }

  const room = rooms.get(code);
  socket.leave(code);
  players.delete(socket.id);

  for (const [id, shot] of shots) {
    if (shot.owner === socket.id) {
      shots.delete(id);
      io.to(code).emit("shotRemove", id);
    }
  }

  if (!room) return;

  room.players.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.values().next().value;
  }

  if (announce) {
    io.to(code).emit("playerLeft", socket.id);
    sendRoomInfo(code);
    sendLeaderboard(code);
  }
}

function sendLeaderboard(code) {
  const room = rooms.get(code);
  if (!room) return;

  const list = roomPlayers(code)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      deaths: p.deaths
    }));

  io.to(code).emit("leaderboard", list);
}

function fail(socket, message) {
  socket.emit("roomError", message);
}

function enterRoom(socket, code, name) {
  const room = rooms.get(code);
  if (!room) return fail(socket, "Room tidak ditemukan.");
  if (room.players.size >= ROOM_CAPACITY) {
    return fail(socket, "Room sudah penuh.");
  }
  if (players.has(socket.id)) {
    return fail(socket, "Kamu sudah berada di room.");
  }

  const spawn = spawnPoint();
  const p = {
    id: socket.id,
    name: cleanName(name),
    room: code,
    x: spawn.x,
    y: 0,
    z: spawn.z,
    rot: 0,
    color: COLORS[room.players.size % COLORS.length],
    hp: 100,
    score: 0,
    deaths: 0,
    moving: false,
    alive: true,
    lastMove: 0,
    lastShot: 0,
    lastHit: 0
  };

  players.set(socket.id, p);
  room.players.add(socket.id);
  socket.join(code);

  socket.emit("welcome", {
    id: socket.id,
    player: publicPlayer(p),
    arena: ARENA,
    roomCode: code
  });

  socket.emit("world", {
    players: roomPlayers(code).filter(q => q.id !== socket.id),
    shots: [...shots.values()].filter(s => s.room === code)
  });

  socket.to(code).emit("playerJoined", publicPlayer(p));
  sendRoomInfo(code);
  sendLeaderboard(code);
}

io.on("connection", socket => {
  socket.on("createRoom", data => {
    if (players.has(socket.id)) {
      return fail(socket, "Keluar dari room saat ini terlebih dahulu.");
    }

    const code = makeCode();
    rooms.set(code, {
      code,
      hostId: socket.id,
      players: new Set()
    });

    enterRoom(socket, code, data && data.name);
  });

  socket.on("joinRoom", data => {
    if (players.has(socket.id)) {
      return fail(socket, "Kamu sudah berada di room.");
    }

    const code = cleanCode(data && data.code);
    if (code.length !== 6) {
      return fail(socket, "Kode room harus terdiri dari 6 karakter.");
    }

    enterRoom(socket, code, data && data.name);
  });

  socket.on("leaveRoom", () => {
    removePlayerFromRoom(socket);
    socket.emit("roomLeft");
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data || !p.room) return;

    const now = Date.now();
    if (now - p.lastMove < 25) return;

    const x = Number(data.x);
    const z = Number(data.z);
    const rot = Number(data.rot);

    if (![x, z, rot].every(Number.isFinite)) return;
    if (Math.abs(x) > ARENA + 5 || Math.abs(z) > ARENA + 5) return;

    p.lastMove = now;
    p.x = Math.max(-ARENA + 2, Math.min(ARENA - 2, x));
    p.z = Math.max(-ARENA + 2, Math.min(ARENA - 2, z));
    p.rot = Math.max(-Math.PI * 4, Math.min(Math.PI * 4, rot));
    p.moving = Boolean(data.moving);

    socket.to(p.room).emit("playerMoved", publicPlayer(p));
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !p.room || !data) return;

    const now = Date.now();
    if (now - p.lastShot < 260) return;

    const dx = Number(data.dx);
    const dz = Number(data.dz);
    if (![dx, dz].every(Number.isFinite)) return;

    const length = Math.hypot(dx, dz);
    if (length < 0.5 || length > 1.5) return;

    p.lastShot = now;

    const shot = {
      id: `${socket.id}-${now}-${Math.random().toString(36).slice(2, 7)}`,
      owner: socket.id,
      room: p.room,
      x: p.x,
      y: 1.35,
      z: p.z,
      dx: dx / length,
      dz: dz / length,
      born: now,
      color: p.color
    };

    shots.set(shot.id, shot);
    io.to(p.room).emit("shotSpawn", shot);
  });

  socket.on("hit", data => {
    const attacker = players.get(socket.id);
    if (!attacker || !attacker.alive || !attacker.room || !data) return;

    const target = players.get(String(data.target));
    const shot = shots.get(String(data.shotId));

    if (!target || !shot || shot.owner !== socket.id) return;
    if (target.room !== attacker.room || shot.room !== attacker.room) return;
    if (target.id === attacker.id || !target.alive) return;

    const now = Date.now();
    if (now - (target.lastHit || 0) < 90) return;
    if (now - shot.born > 1800) return;

    const hitX = Number(data.x);
    const hitZ = Number(data.z);
    if (![hitX, hitZ].every(Number.isFinite)) return;

    if (Math.hypot(target.x - hitX, target.z - hitZ) > 2.0) return;

    shots.delete(shot.id);
    io.to(attacker.room).emit("shotRemove", shot.id);

    target.lastHit = now;
    target.hp = Math.max(0, target.hp - 25);

    io.to(attacker.room).emit("playerHit", {
      target: target.id,
      hp: target.hp,
      by: attacker.id,
      shotId: shot.id
    });

    if (target.hp <= 0) {
      target.alive = false;
      target.deaths += 1;
      attacker.score += 1;

      io.to(attacker.room).emit("playerDown", {
        id: target.id,
        by: attacker.id,
        score: attacker.score
      });

      const targetId = target.id;
      const targetRoom = target.room;

      setTimeout(() => {
        const current = players.get(targetId);
        if (!current || current.room !== targetRoom) return;

        const spawn = spawnPoint();
        current.x = spawn.x;
        current.z = spawn.z;
        current.hp = 100;
        current.alive = true;

        io.to(targetRoom).emit("playerRespawn", publicPlayer(current));
      }, 2400);
    }

    sendLeaderboard(attacker.room);
  });

  socket.on("disconnect", () => {
    removePlayerFromRoom(socket);
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [id, shot] of shots) {
    if (now - shot.born > 1800) {
      shots.delete(id);
      const room = rooms.get(shot.room);
      if (room) io.to(shot.room).emit("shotRemove", id);
    }
  }

  for (const code of rooms.keys()) sendLeaderboard(code);
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NEON FRONTIER running on port ${PORT}`);
});
