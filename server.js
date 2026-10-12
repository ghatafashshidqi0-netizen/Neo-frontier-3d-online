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
const appRoot = path.join(__dirname, "public");
app.use(express.static(appRoot));
app.get("/health", (_req, res) => res.json({ ok: true, game: "NEON FRONTIER" }));

const players = new Map();
const shots = new Map();
const ARENA = 42;
const COLORS = ["#55e7ff", "#ff4f9a", "#a78bfa", "#facc15", "#4ade80", "#fb923c", "#f472b6", "#60a5fa"];

function randSpawn() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 5 + Math.random() * 12;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}
function cleanName(value) {
  return String(value || "Ranger").replace(/[<>]/g, "").trim().slice(0, 16) || "Ranger";
}
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, x: p.x, y: p.y, z: p.z,
    rot: p.rot, color: p.color, hp: p.hp, score: p.score,
    deaths: p.deaths, moving: p.moving, alive: p.alive
  };
}
io.on("connection", socket => {
  socket.on("join", data => {
    if (players.has(socket.id)) return;
    const spawn = randSpawn();
    const p = {
      id: socket.id, name: cleanName(data && data.name),
      x: spawn.x, y: 0, z: spawn.z, rot: 0,
      color: COLORS[players.size % COLORS.length],
      hp: 100, score: 0, deaths: 0, moving: false, alive: true,
      lastMove: 0, lastShot: 0, lastHit: 0
    };
    players.set(socket.id, p);
    socket.emit("welcome", { id: socket.id, player: publicPlayer(p), arena: ARENA });
    socket.broadcast.emit("playerJoined", publicPlayer(p));
    socket.emit("world", {
      players: [...players.values()].filter(q => q.id !== socket.id).map(publicPlayer),
      shots: [...shots.values()]
    });
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data || !p.alive) return;
    const now = Date.now();
    // Server-side bounds and basic rate protection.
    const x = Number(data.x), z = Number(data.z), rot = Number(data.rot);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(rot)) return;
    if (now - p.lastMove < 12) return;
    p.lastMove = now;
    p.x = Math.max(-ARENA + 2, Math.min(ARENA - 2, x));
    p.z = Math.max(-ARENA + 2, Math.min(ARENA - 2, z));
    p.rot = rot;
    p.moving = !!data.moving;
    socket.broadcast.emit("playerMoved", publicPlayer(p));
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data) return;
    const now = Date.now();
    if (now - p.lastShot < 260) return;
    p.lastShot = now;
    const dx = Number(data.dx), dz = Number(data.dz);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    const length = Math.hypot(dx, dz) || 1;
    const shot = {
      id: `${socket.id}-${now}-${Math.random().toString(36).slice(2, 7)}`,
      owner: socket.id, x: p.x, y: 1.35, z: p.z,
      dx: dx / length, dz: dz / length, born: now, color: p.color
    };
    shots.set(shot.id, shot);
    io.emit("shotSpawn", shot);
  });

  socket.on("hit", data => {
    const attacker = players.get(socket.id);
    const target = data && players.get(String(data.target));
    const shot = data && shots.get(String(data.shotId));
    if (!attacker || !target || !shot || shot.owner !== socket.id || target.id === attacker.id) return;
    if (!target.alive || Date.now() - (target.lastHit || 0) < 90) return;
    // Check the target against the projectile position reported by the client.
    // This is suitable for a small prototype; competitive games should simulate
    // projectile movement and collision authoritatively on the server.
    const hitX = Number(data.x), hitZ = Number(data.z);
    if (!Number.isFinite(hitX) || !Number.isFinite(hitZ)) return;
    const distance = Math.hypot(target.x - hitX, target.z - hitZ);
    if (distance > 2.0 || Date.now() - shot.born > 1800) return;
    shots.delete(shot.id);
    target.lastHit = Date.now();
    target.hp = Math.max(0, target.hp - 25);
    io.emit("playerHit", { target: target.id, hp: target.hp, by: attacker.id, shotId: shot.id });
    if (target.hp <= 0) {
      target.alive = false;
      target.deaths += 1;
      attacker.score += 1;
      io.emit("playerDown", { id: target.id, by: attacker.id, score: attacker.score });
      setTimeout(() => {
        const current = players.get(target.id);
        if (!current) return;
        const spawn = randSpawn();
        current.x = spawn.x; current.z = spawn.z;
        current.hp = 100; current.alive = true;
        io.emit("playerRespawn", publicPlayer(current));
      }, 2400);
    }
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    for (const [id, shot] of shots) if (shot.owner === socket.id) shots.delete(id);
    io.emit("playerLeft", socket.id);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, shot] of shots) {
    if (now - shot.born > 1500) {
      shots.delete(id);
      io.emit("shotRemove", id);
    }
  }
  io.emit("leaderboard", [...players.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(p => ({ id: p.id, name: p.name, score: p.score, deaths: p.deaths })));
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NEON FRONTIER running on port ${PORT}`);
});
