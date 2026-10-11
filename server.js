
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ online: true, game: "Tactical Strike" }));

const rooms = new Map();
const MAX_TEAM = 5;
const MAX_PLAYERS = 10;
const MAGAZINE = 20;
const RELOAD_MS = 1600;
const SHOT_DELAY = 105;
const ROUND_DELAY = 3500;
const WIN_SCORE = 12;

// Must match the building and wall coordinates in public/index.html.
const WALLS = [
  {x:0,z:-24,w:50,d:1,h:7},{x:0,z:24,w:50,d:1,h:7},
  {x:-24,z:0,w:1,d:50,h:7},{x:24,z:0,w:1,d:50,h:7},
  {x:-9,z:-13,w:8,d:10,h:7},{x:-9,z:13,w:8,d:10,h:7},
  {x:9,z:-13,w:8,d:10,h:7},{x:9,z:13,w:8,d:10,h:7},
  {x:-19,z:-19,w:5,d:5,h:11},{x:19,z:-19,w:5,d:5,h:11},
  {x:-19,z:19,w:5,d:5,h:11},{x:19,z:19,w:5,d:5,h:11},
  {x:-3.8,z:-5.5,w:1.2,d:5,h:2.3},{x:3.8,z:5.5,w:1.2,d:5,h:2.3},
  {x:-3.8,z:5.5,w:1.2,d:5,h:2.3},{x:3.8,z:-5.5,w:1.2,d:5,h:2.3},
  {x:-15,z:-6,w:4.5,d:1.1,h:2.5},{x:15,z:6,w:4.5,d:1.1,h:2.5},
  {x:-15,z:6,w:4.5,d:1.1,h:2.5},{x:15,z:-6,w:4.5,d:1.1,h:2.5},
  {x:0,z:-2.7,w:5.8,d:1,h:1.35},{x:0,z:2.7,w:5.8,d:1,h:1.35},
  // Tall central divider: breaks direct line of sight between spawn sides.
  {x:0,z:0,w:1.4,d:5.5,h:4.4},
  {x:0,z:-18,w:1.4,d:10,h:4.4},{x:0,z:18,w:1.4,d:10,h:4.4}
];

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(s) {
  if (typeof s !== "string") return "Player";
  return s.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 16) || "Player";
}

function makeRoom(hostId) {
  return {
    hostId, players: new Map(), phase: "lobby", roundNumber: 1,
    redWins: 0, blueWins: 0, matchWinner: null, lastRoundWinner: null,
    roundTimer: null
  };
}

function count(room, team) {
  return [...room.players.values()].filter(p => p.team === team).length;
}

function publicState(room) {
  return {
    hostId: room.hostId,
    phase: room.phase,
    roundNumber: room.roundNumber,
    redWins: room.redWins,
    blueWins: room.blueWins,
    matchWinner: room.matchWinner,
    lastRoundWinner: room.lastRoundWinner,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team,
      x: p.x, y: p.crouched ? 1.05 : 1.7, z: p.z,
      yaw: p.yaw, pitch: p.pitch, health: p.health, ammo: p.ammo,
      alive: p.alive, reloading: p.reloading, crouched: p.crouched
    }))
  };
}

function broadcast(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit("matchState", publicState(room));
}

function chooseTeam(room) {
  const red = count(room, "red"), blue = count(room, "blue");
  if (red >= MAX_TEAM && blue >= MAX_TEAM) return null;
  if (red >= MAX_TEAM) return "blue";
  if (blue >= MAX_TEAM) return "red";
  return red <= blue ? "red" : "blue";
}

function resetPlayer(p, room) {
  const teamPlayers = [...room.players.values()]
    .filter(q => q.team === p.team)
    .sort((a, b) => a.id.localeCompare(b.id));
  const index = Math.max(0, teamPlayers.findIndex(q => q.id === p.id));
  p.x = p.team === "red" ? -18 : 18;
  p.z = (index - (teamPlayers.length - 1) / 2) * 2.1;

  // Red looks down the north lane; blue looks down the south lane.
  // Neither team starts aiming directly at the other team's spawn.
  p.yaw = p.team === "red" ? 0 : Math.PI;
  p.pitch = 0;
  p.health = 100;
  p.ammo = MAGAZINE;
  p.alive = true;
  p.reloading = false;
  p.crouched = false;
  p.lastShot = 0;
  p.reloadToken = (p.reloadToken || 0) + 1;
  p.lastState = 0;
}

function startRound(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.phase = "playing";
  room.lastRoundWinner = null;
  for (const p of room.players.values()) resetPlayer(p, room);
  broadcast(code);
  io.to(code).emit("combatMessage", { text: `ROUND ${room.roundNumber} - FIGHT!` });
}

function startMatch(socket) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  if (!room || room.hostId !== socket.id) {
    socket.emit("roomError", "Only the host can start the match.");
    return;
  }
  if (room.phase !== "lobby") return;
  if (!count(room, "red") || !count(room, "blue")) {
    socket.emit("roomError", "Both teams need at least one player.");
    return;
  }
  if (count(room, "red") > MAX_TEAM || count(room, "blue") > MAX_TEAM) {
    socket.emit("roomError", "Teams can only have five players each.");
    return;
  }
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = null;
  room.redWins = 0;
  room.blueWins = 0;
  room.roundNumber = 1;
  room.matchWinner = null;
  room.lastRoundWinner = null;
  startRound(code);
}

function checkRoundEnd(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== "playing") return;
  const red = [...room.players.values()].filter(p => p.team === "red");
  const blue = [...room.players.values()].filter(p => p.team === "blue");
  if (!red.length || !blue.length) return;
  const redAlive = red.some(p => p.alive);
  const blueAlive = blue.some(p => p.alive);
  if (redAlive && blueAlive) return;

  const winner = redAlive && !blueAlive ? "red" :
                 blueAlive && !redAlive ? "blue" : null;
  room.lastRoundWinner = winner;
  if (winner === "red") room.redWins++;
  if (winner === "blue") room.blueWins++;

  if (room.redWins >= WIN_SCORE || room.blueWins >= WIN_SCORE) {
    room.matchWinner = room.redWins >= WIN_SCORE ? "red" : "blue";
    room.phase = "lobby";
    room.roundTimer = null;
    broadcast(code);
    io.to(code).emit("combatMessage", {
      text: `${room.matchWinner.toUpperCase()} TEAM WINS THE MATCH!`
    });
    return;
  }

  room.phase = "between";
  broadcast(code);
  room.roundTimer = setTimeout(() => {
    const r = rooms.get(code);
    if (!r || r.phase !== "between") return;
    r.roundTimer = null;
    if (!count(r, "red") || !count(r, "blue")) {
      r.phase = "lobby";
      broadcast(code);
      return;
    }
    r.roundNumber++;
    startRound(code);
  }, ROUND_DELAY);
}

// Returns the first positive distance at which a ray intersects a box.
function rayBoxDistance(origin, direction, b) {
  const min = [b.x-b.w/2, 0, b.z-b.d/2];
  const max = [b.x+b.w/2, b.h, b.z+b.d/2];
  const o = [origin.x, origin.y, origin.z];
  const d = [direction.x, direction.y, direction.z];
  let tMin = -Infinity, tMax = Infinity;

  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 0.000001) {
      if (o[i] < min[i] || o[i] > max[i]) return Infinity;
      continue;
    }
    let a = (min[i] - o[i]) / d[i];
    let b2 = (max[i] - o[i]) / d[i];
    if (a > b2) [a, b2] = [b2, a];
    tMin = Math.max(tMin, a);
    tMax = Math.min(tMax, b2);
    if (tMax < tMin) return Infinity;
  }
  if (tMax < 0) return Infinity;
  return tMin >= 0 ? tMin : tMax;
}

function findTarget(room, shooter, direction, origin) {
  let wallDistance = Infinity;
  for (const wall of WALLS) {
    wallDistance = Math.min(wallDistance, rayBoxDistance(origin, direction, wall));
  }

  let best = null;
  for (const target of room.players.values()) {
    if (target.id === shooter.id || target.team === shooter.team || !target.alive) continue;

    const centerY = target.crouched ? 1.05 : 1.7;
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const horizontalSq = direction.x * direction.x + direction.z * direction.z;
    if (horizontalSq < 0.0001) continue;

    const t = (dx * direction.x + dz * direction.z) / horizontalSq;
    if (t <= 0) continue;

    const hitX = origin.x + direction.x * t;
    const hitZ = origin.z + direction.z * t;
    if (Math.hypot(hitX - target.x, hitZ - target.z) > 0.48) continue;

    const distance = t / Math.sqrt(horizontalSq);
    const hitY = origin.y + direction.y * distance;
    if (hitY < centerY - 1.0 || hitY > centerY + 0.35) continue;
    if (best && distance >= best.distance) continue;

    let zone, damage;
    if (hitY >= centerY + 0.16) {
      zone = "head"; damage = 40;
    } else if (hitY < centerY - 0.48) {
      zone = "legs"; damage = 10;
    } else {
      zone = "body"; damage = 15;
    }
    best = { target, zone, damage, distance };
  }

  if (best && wallDistance < best.distance) return { blocked: true, distance: wallDistance };
  if (best) return best;
  return { blocked: false, distance: wallDistance };
}

function fireShot(socket, aim) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  const shooter = room && room.players.get(socket.id);
  if (!room || !shooter || room.phase !== "playing" || !shooter.alive) return;

  const now = Date.now();
  if (now - shooter.lastShot < SHOT_DELAY) return;
  if (shooter.reloading) {
    socket.emit("shotResult", { ammo: shooter.ammo, reloading: true });
    return;
  }
  if (shooter.ammo <= 0) {
    socket.emit("shotResult", { ammo: 0, reloading: false });
    return;
  }

  shooter.lastShot = now;
  shooter.ammo--;

  if (aim && typeof aim === "object") {
    if (Number.isFinite(aim.yaw)) shooter.yaw = aim.yaw;
    if (Number.isFinite(aim.pitch)) shooter.pitch = Math.max(-1.25, Math.min(1.25, aim.pitch));
  }

  const cp = Math.cos(shooter.pitch);
  const direction = {
    x: -Math.sin(shooter.yaw) * cp,
    y: Math.sin(shooter.pitch),
    z: -Math.cos(shooter.yaw) * cp
  };
  const mag = Math.hypot(direction.x, direction.y, direction.z) || 1;
  direction.x /= mag;
  direction.y /= mag;
  direction.z /= mag;

  // The origin uses the same eye height as the browser's first-person camera.
  const origin = {
    x: shooter.x,
    y: shooter.crouched ? 1.05 : 1.7,
    z: shooter.z
  };

  const result = findTarget(room, shooter, direction, origin);
  const distance = Math.min(
    Number.isFinite(result.distance) ? result.distance : 35,
    35
  );
  const endpoint = {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
    z: origin.z + direction.z * distance
  };

  // This is the authoritative bullet line, matching the direction used for hit tests.
  io.to(code).emit("shotTrace", {
    id: shooter.id,
    from: origin,
    to: endpoint
  });

  const response = { ammo: shooter.ammo, reloading: shooter.reloading };

  if (result.blocked) {
    response.blocked = true;
  } else if (result.target && result.distance <= 35) {
    const target = result.target;
    target.health = Math.max(0, target.health - result.damage);
    if (target.health <= 0) {
      target.alive = false;
      target.reloading = false;
      target.reloadToken = (target.reloadToken || 0) + 1;
    }

    response.hit = true;
    response.zone = result.zone;
    response.damage = result.damage;
    response.targetId = target.id;
    response.eliminated = !target.alive;

    io.to(code).emit("playerDamaged", {
      id: target.id,
      health: target.health,
      damage: result.damage,
      alive: target.alive,
      eliminated: !target.alive
    });

    if (!target.alive) {
      io.to(code).emit("combatMessage", { text: `${target.name} was eliminated` });
    }
  }

  socket.emit("shotResult", response);
  broadcast(code);
  checkRoundEnd(code);
}

function reloadPlayer(socket) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  const p = room && room.players.get(socket.id);
  if (!room || !p || room.phase !== "playing" || !p.alive) return;
  if (p.reloading || p.ammo >= MAGAZINE) return;

  p.reloading = true;
  const token = ++p.reloadToken;
  io.to(code).emit("reloadState", { id: p.id, ammo: p.ammo, reloading: true });
  broadcast(code);

  setTimeout(() => {
    const r = rooms.get(code);
    const current = r && r.players.get(p.id);
    if (!r || !current || current.reloadToken !== token) return;
    if (r.phase !== "playing" || !current.alive) {
      current.reloading = false;
      return;
    }
    current.ammo = MAGAZINE;
    current.reloading = false;
    io.to(code).emit("reloadState", {
      id: current.id, ammo: current.ammo, reloading: false
    });
    broadcast(code);
  }, RELOAD_MS);
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.data.roomCode = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return;

  room.players.delete(socket.id);
  if (!room.players.size) {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
    io.to(code).emit("combatMessage", { text: "A new host has been selected." });
  }

  broadcast(code);
  if (room.phase === "playing" || room.phase === "between") {
    if (!count(room, "red") || !count(room, "blue")) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      room.roundTimer = null;
      room.phase = "lobby";
      broadcast(code);
    } else if (room.phase === "playing") {
      checkRoundEnd(code);
    }
  }
}

function addPlayer(socket, room, code, name, team) {
  const p = {
    id: socket.id,
    name: cleanName(name),
    team,
    x: team === "red" ? -18 : 18,
    z: 0,
    yaw: team === "red" ? 0 : Math.PI,
    pitch: 0,
    health: 100,
    ammo: MAGAZINE,
    alive: true,
    reloading: false,
    crouched: false,
    lastShot: 0,
    reloadToken: 0,
    lastState: 0
  };
  room.players.set(socket.id, p);
  socket.join(code);
  socket.data.roomCode = code;
  socket.emit("joinedRoom", {
    roomCode: code,
    id: socket.id,
    hostId: room.hostId,
    state: publicState(room)
  });
  broadcast(code);
}

function joinRoom(socket, code, name) {
  if (typeof code !== "string") return;
  code = code.trim().toUpperCase();

  if (!/^[A-Z0-9]{5}$/.test(code)) {
    socket.emit("roomError", "Room codes must be 5 letters or numbers.");
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    socket.emit("roomError", "That room doesn't exist. Ask the host to create it first.");
    return;
  }
  if (room.phase !== "lobby") {
    socket.emit("roomError", "That match is in progress. Try again after it ends.");
    return;
  }
  if (socket.data.roomCode === code && room.players.has(socket.id)) {
    socket.emit("joinedRoom", {
      roomCode: code, id: socket.id, hostId: room.hostId, state: publicState(room)
    });
    return;
  }
  if (room.players.size >= MAX_PLAYERS) {
    socket.emit("roomError", "This lobby is full (10 players maximum).");
    return;
  }

  leaveRoom(socket);
  const current = rooms.get(code);
  if (!current) {
    socket.emit("roomError", "That room is no longer available.");
    return;
  }
  const team = chooseTeam(current);
  if (!team) {
    socket.emit("roomError", "Both teams are full.");
    return;
  }
  addPlayer(socket, current, code, name, team);
  console.log(`${cleanName(name)} joined room ${code} (${team})`);
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("createRoom", name => {
    leaveRoom(socket);
    const code = roomCode();
    const room = makeRoom(socket.id);
    rooms.set(code, room);
    addPlayer(socket, room, code, name, "red");
    console.log(`${cleanName(name)} created room ${code}`);
  });

  socket.on("joinRoom", data => {
    if (data && typeof data === "object") joinRoom(socket, data.roomCode, data.name);
  });

  socket.on("setTeam", data => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || room.phase !== "lobby" || room.hostId !== socket.id) return;
    if (!data || typeof data.playerId !== "string" || !["red", "blue"].includes(data.team)) return;
    const p = room.players.get(data.playerId);
    if (!p || p.team === data.team) return;
    if (count(room, data.team) >= MAX_TEAM) {
      socket.emit("roomError", "That team already has five players.");
      return;
    }
    p.team = data.team;
    broadcast(code);
  });

  socket.on("startMatch", () => startMatch(socket));
  socket.on("leaveRoom", () => leaveRoom(socket));

  socket.on("playerState", data => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    const p = room && room.players.get(socket.id);
    if (!room || !p || room.phase !== "playing" || !p.alive || !data) return;
    const now = Date.now();
    if (now - p.lastState < 25) return;
    p.lastState = now;

    const num = (v, fallback) => Number.isFinite(v) ? v : fallback;
    p.x = Math.max(-22.5, Math.min(22.5, num(data.x, p.x)));
    p.z = Math.max(-22.5, Math.min(22.5, num(data.z, p.z)));
    p.yaw = num(data.yaw, p.yaw);
    p.pitch = Math.max(-1.25, Math.min(1.25, num(data.pitch, p.pitch)));
    p.crouched = Boolean(data.crouched);

    socket.to(code).emit("playerMoved", {
      id: p.id, x: p.x, y: p.crouched ? 1.05 : 1.7, z: p.z,
      yaw: p.yaw, pitch: p.pitch, crouched: p.crouched
    });
  });

  socket.on("shoot", aim => fireShot(socket, aim));
  socket.on("reload", () => reloadPlayer(socket));
  socket.on("disconnect", () => {
    leaveRoom(socket);
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Tactical Strike running on port ${PORT}`);
});
