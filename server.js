
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ online: true, game: "Tactical Strike" });
});

const rooms = new Map();
const MAX_TEAM_SIZE = 5;
const MAX_PLAYERS = 10;
const MAGAZINE_SIZE = 20;
const RELOAD_MS = 1600;
const SHOT_COOLDOWN_MS = 105;
const ROUND_DELAY_MS = 3500;
const WINNING_SCORE = 12;

const COVER = [
  { x: -5, z: -7, w: 5, d: 1.4, h: 2.1 },
  { x: 5, z: 7, w: 5, d: 1.4, h: 2.1 },
  { x: 0, z: 0, w: 1.4, d: 7, h: 2.5 },
  { x: -9, z: 4, w: 2.3, d: 3.2, h: 1.5 },
  { x: 9, z: -4, w: 2.3, d: 3.2, h: 1.5 },
  { x: -5, z: 12, w: 4, d: 1.5, h: 1.7 },
  { x: 5, z: -12, w: 4, d: 1.5, h: 1.7 },
  { x: -12, z: -2, w: 1.5, d: 4, h: 1.8 },
  { x: 12, z: 2, w: 1.5, d: 4, h: 1.8 },
  { x: -3, z: -15, w: 3, d: 1.5, h: 1.4 },
  { x: 3, z: 15, w: 3, d: 1.5, h: 1.4 }
];

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function cleanName(value) {
  if (typeof value !== "string") return "Player";
  return value.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 16) || "Player";
}

function makeRoom(hostId) {
  return {
    hostId,
    players: new Map(),
    phase: "lobby",
    roundNumber: 1,
    redWins: 0,
    blueWins: 0,
    matchWinner: null,
    lastRoundWinner: null,
    roundTimer: null
  };
}

function teamCount(room, team) {
  return [...room.players.values()].filter(p => p.team === team).length;
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    color: p.team === "red" ? "#bd625b" : "#6598cf",
    team: p.team,
    x: p.x,
    y: 1.7,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    health: p.health,
    ammo: p.ammo,
    alive: p.alive,
    reloading: p.reloading
  }));
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
    players: publicPlayers(room)
  };
}

function broadcastState(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("matchState", publicState(room));
}

function getPlayerTeamCounts(room) {
  return {
    red: teamCount(room, "red"),
    blue: teamCount(room, "blue")
  };
}

function chooseTeam(room) {
  const counts = getPlayerTeamCounts(room);

  if (counts.red >= MAX_TEAM_SIZE && counts.blue >= MAX_TEAM_SIZE) return null;
  if (counts.red >= MAX_TEAM_SIZE) return "blue";
  if (counts.blue >= MAX_TEAM_SIZE) return "red";

  return counts.red <= counts.blue ? "red" : "blue";
}

function resetPlayerForRound(player, room) {
  const teamPlayers = [...room.players.values()]
    .filter(p => p.team === player.team)
    .sort((a, b) => a.id.localeCompare(b.id));

  const index = Math.max(0, teamPlayers.findIndex(p => p.id === player.id));
  const z = (index - (teamPlayers.length - 1) / 2) * 2.1;

  player.x = player.team === "red" ? -15 : 15;
  player.z = z;
  player.yaw = player.team === "red" ? -Math.PI / 2 : Math.PI / 2;
  player.pitch = 0;
  player.health = 100;
  player.ammo = MAGAZINE_SIZE;
  player.alive = true;
  player.reloading = false;
  player.lastShot = 0;
  player.reloadToken = (player.reloadToken || 0) + 1;
  player.lastState = 0;
}

function startRound(code) {
  const room = rooms.get(code);
  if (!room) return;

  room.phase = "playing";
  room.lastRoundWinner = null;

  for (const player of room.players.values()) {
    resetPlayerForRound(player, room);
  }

  broadcastState(code);
}

function startMatch(socket) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);

  if (!room || socket.id !== room.hostId) {
    socket.emit("roomError", "Only the host can start the match.");
    return;
  }

  if (room.phase !== "lobby") {
    socket.emit("roomError", "The match is already running.");
    return;
  }

  const counts = getPlayerTeamCounts(room);
  if (!counts.red || !counts.blue) {
    socket.emit("roomError", "Both teams need at least one player.");
    return;
  }

  if (counts.red > MAX_TEAM_SIZE || counts.blue > MAX_TEAM_SIZE) {
    socket.emit("roomError", "Teams can only have five players each.");
    return;
  }

  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

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

  const redPlayers = [...room.players.values()].filter(p => p.team === "red");
  const bluePlayers = [...room.players.values()].filter(p => p.team === "blue");

  const redAlive = redPlayers.some(p => p.alive);
  const blueAlive = bluePlayers.some(p => p.alive);

  // A round cannot finish before both teams have players.
  if (!redPlayers.length || !bluePlayers.length) return;
  if (redAlive && blueAlive) return;

  let winner = null;

  if (redAlive && !blueAlive) winner = "red";
  else if (blueAlive && !redAlive) winner = "blue";

  room.lastRoundWinner = winner;

  if (winner === "red") room.redWins++;
  if (winner === "blue") room.blueWins++;

  if (room.redWins >= WINNING_SCORE || room.blueWins >= WINNING_SCORE) {
    room.matchWinner = room.redWins >= WINNING_SCORE ? "red" : "blue";
    room.phase = "lobby";
    room.roundTimer = null;
    broadcastState(code);
    io.to(code).emit("combatMessage", {
      text: `${room.matchWinner.toUpperCase()} TEAM WINS THE MATCH!`
    });
    return;
  }

  room.phase = "between";
  broadcastState(code);

  room.roundTimer = setTimeout(() => {
    const current = rooms.get(code);
    if (!current || current.phase !== "between") return;

    current.roundNumber++;
    current.roundTimer = null;

    const counts = getPlayerTeamCounts(current);
    if (!counts.red || !counts.blue) {
      current.phase = "lobby";
      broadcastState(code);
      return;
    }

    startRound(code);
  }, ROUND_DELAY_MS);
}

function rayBoxDistance(origin, direction, box) {
  const min = [
    box.x - box.w / 2,
    0,
    box.z - box.d / 2
  ];
  const max = [
    box.x + box.w / 2,
    box.h,
    box.z + box.d / 2
  ];
  const o = [origin.x, origin.y, origin.z];
  const d = [direction.x, direction.y, direction.z];

  let tMin = -Infinity;
  let tMax = Infinity;

  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 0.000001) {
      if (o[axis] < min[axis] || o[axis] > max[axis]) return Infinity;
      continue;
    }

    let t1 = (min[axis] - o[axis]) / d[axis];
    let t2 = (max[axis] - o[axis]) / d[axis];

    if (t1 > t2) {
      const temp = t1;
      t1 = t2;
      t2 = temp;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);

    if (tMax < tMin) return Infinity;
  }

  if (tMax < 0) return Infinity;
  return tMin >= 0 ? tMin : tMax;
}

function findShotTarget(room, shooter, direction) {
  const origin = { x: shooter.x, y: 1.7, z: shooter.z };

  // Stop shots at the outer walls or any piece of cover.
  const blockers = [
    { x: 0, z: -22, w: 44, d: 1, h: 6 },
    { x: 0, z: 22, w: 44, d: 1, h: 6 },
    { x: -22, z: 0, w: 1, d: 44, h: 6 },
    { x: 22, z: 0, w: 1, d: 44, h: 6 },
    ...COVER
  ];

  let blockDistance = Infinity;
  for (const b of blockers) {
    blockDistance = Math.min(blockDistance, rayBoxDistance(origin, direction, b));
  }

  let best = null;
  let bestDistance = Infinity;

  for (const target of room.players.values()) {
    if (target.id === shooter.id || target.team === shooter.team || !target.alive) continue;

    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const horizontalDirSq = direction.x * direction.x + direction.z * direction.z;

    if (horizontalDirSq < 0.0001) continue;

    const t = (dx * direction.x + dz * direction.z) / horizontalDirSq;
    if (t <= 0) continue;

    const hitX = origin.x + direction.x * t;
    const hitZ = origin.z + direction.z * t;
    const horizontalDistance = Math.hypot(hitX - target.x, hitZ - target.z);

    if (horizontalDistance > 0.43) continue;

    const rayDistance = t / Math.sqrt(horizontalDirSq);
    const hitY = origin.y + direction.y * rayDistance;

    if (hitY < 0.08 || hitY > 2.18) continue;
    if (rayDistance >= bestDistance) continue;

    let zone;
    let damage;

    if (hitY >= 1.52) {
      zone = "head";
      damage = 40;
    } else if (hitY < 0.72) {
      zone = "legs";
      damage = 10;
    } else {
      zone = "body";
      damage = 15;
    }

    best = { target, zone, damage, distance: rayDistance };
    bestDistance = rayDistance;
  }

  if (best && blockDistance < best.distance) return { blocked: true };
  return best;
}

function fireShot(socket, aim) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  const shooter = room && room.players.get(socket.id);

  if (!room || !shooter || room.phase !== "playing" || !shooter.alive) return;

  const now = Date.now();

  if (now - shooter.lastShot < SHOT_COOLDOWN_MS) return;
  if (shooter.reloading) {
    socket.emit("shotResult", {
      ammo: shooter.ammo,
      reloading: true
    });
    return;
  }

  if (shooter.ammo <= 0) {
    socket.emit("shotResult", {
      ammo: 0,
      reloading: false
    });
    return;
  }

  shooter.lastShot = now;
  shooter.ammo--;

  if (aim && typeof aim === "object") {
    if (Number.isFinite(aim.yaw)) shooter.yaw = aim.yaw;
    if (Number.isFinite(aim.pitch)) {
      shooter.pitch = Math.max(-1.35, Math.min(1.35, aim.pitch));
    }
  }

  const direction = {
    x: -Math.sin(shooter.yaw) * Math.cos(shooter.pitch),
    y: Math.sin(shooter.pitch),
    z: -Math.cos(shooter.yaw) * Math.cos(shooter.pitch)
  };

  const magnitude = Math.hypot(direction.x, direction.y, direction.z) || 1;
  direction.x /= magnitude;
  direction.y /= magnitude;
  direction.z /= magnitude;

  io.to(code).emit("playerShot", {
    id: shooter.id,
    x: shooter.x,
    y: 1.7,
    z: shooter.z,
    yaw: shooter.yaw,
    pitch: shooter.pitch
  });

  const result = findShotTarget(room, shooter, direction);
  const response = {
    ammo: shooter.ammo,
    reloading: shooter.reloading
  };

  if (result && result.blocked) {
    response.blocked = true;
  } else if (result && result.target) {
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
      io.to(code).emit("combatMessage", {
        text: `${target.name} was eliminated`
      });
    }
  }

  socket.emit("shotResult", response);
  broadcastState(code);
  checkRoundEnd(code);
}

function reloadPlayer(socket) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  const player = room && room.players.get(socket.id);

  if (!room || !player || room.phase !== "playing" || !player.alive) return;
  if (player.reloading || player.ammo >= MAGAZINE_SIZE) return;

  player.reloading = true;
  const token = (player.reloadToken || 0) + 1;
  player.reloadToken = token;

  io.to(code).emit("reloadState", {
    id: player.id,
    ammo: player.ammo,
    reloading: true
  });
  broadcastState(code);

  setTimeout(() => {
    const currentRoom = rooms.get(code);
    const currentPlayer = currentRoom && currentRoom.players.get(player.id);

    if (!currentRoom || !currentPlayer) return;
    if (currentPlayer.reloadToken !== token) return;

    if (currentRoom.phase !== "playing" || !currentPlayer.alive) {
      currentPlayer.reloading = false;
      return;
    }

    currentPlayer.ammo = MAGAZINE_SIZE;
    currentPlayer.reloading = false;

    io.to(code).emit("reloadState", {
      id: currentPlayer.id,
      ammo: currentPlayer.ammo,
      reloading: false
    });
    broadcastState(code);
  }, RELOAD_MS);
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.leave(code);

  if (!room) return;

  room.players.delete(socket.id);

  if (room.players.size === 0) {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
    io.to(code).emit("combatMessage", { text: "A new host has been selected." });
  }

  broadcastState(code);

  if (room.phase === "playing") {
    const redCount = teamCount(room, "red");
    const blueCount = teamCount(room, "blue");

    if (!redCount || !blueCount) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      room.roundTimer = null;
      room.phase = "lobby";
      broadcastState(code);
    } else {
      checkRoundEnd(code);
    }
  } else if (room.phase === "between") {
    const redCount = teamCount(room, "red");
    const blueCount = teamCount(room, "blue");

    if (!redCount || !blueCount) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      room.roundTimer = null;
      room.phase = "lobby";
      broadcastState(code);
    }
  }
}

function joinRoom(socket, roomCode, name) {
  if (typeof roomCode !== "string") return;

  roomCode = roomCode.trim().toUpperCase();

  if (!/^[A-Z0-9]{4}$/.test(roomCode)) {
    socket.emit("roomError", "Room codes must be 4 letters or numbers.");
    return;
  }

  const room = rooms.get(roomCode);

  if (!room) {
    socket.emit("roomError", "That room doesn't exist. Ask the host to create it first.");
    return;
  }

  if (room.phase !== "lobby") {
    socket.emit("roomError", "That match is in progress. Try again after it ends.");
    return;
  }

  if (room.players.size >= MAX_PLAYERS) {
    socket.emit("roomError", "This lobby is full (10 players maximum).");
    return;
  }

  const team = chooseTeam(room);

  if (!team) {
    socket.emit("roomError", "Both teams are full.");
    return;
  }

  leaveCurrentRoom(socket);

  const player = {
    id: socket.id,
    name: cleanName(name),
    team,
    x: team === "red" ? -15 : 15,
    y: 1.7,
    z: 0,
    yaw: team === "red" ? -Math.PI / 2 : Math.PI / 2,
    pitch: 0,
    health: 100,
    ammo: MAGAZINE_SIZE,
    alive: true,
    reloading: false,
    lastState: 0,
    lastShot: 0,
    reloadToken: 0
  };

  room.players.set(socket.id, player);
  socket.join(roomCode);
  socket.data.roomCode = roomCode;

  socket.emit("joinedRoom", {
    roomCode,
    id: socket.id,
    hostId: room.hostId,
    state: publicState(room)
  });

  broadcastState(roomCode);
  console.log(`${player.name} joined ${roomCode} on ${team.toUpperCase()}`);
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("createRoom", name => {
    leaveCurrentRoom(socket);

    const code = makeRoomCode();
    const room = makeRoom(socket.id);
    rooms.set(code, room);

    joinRoom(socket, code, name);
  });

  socket.on("joinRoom", data => {
    if (!data || typeof data !== "object") return;
    joinRoom(socket, data.roomCode, data.name);
  });

  socket.on("setTeam", data => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);

    if (!room || room.phase !== "lobby") return;
    if (socket.id !== room.hostId) return;
    if (!data || typeof data.playerId !== "string") return;
    if (!["red", "blue"].includes(data.team)) return;

    const target = room.players.get(data.playerId);
    if (!target) return;
    if (target.team === data.team) return;

    if (teamCount(room, data.team) >= MAX_TEAM_SIZE) {
      socket.emit("roomError", "That team already has five players.");
      return;
    }

    target.team = data.team;
    broadcastState(code);
  });

  socket.on("startMatch", () => startMatch(socket));

  socket.on("leaveRoom", () => leaveCurrentRoom(socket));

  socket.on("playerState", state => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    const player = room && room.players.get(socket.id);

    if (!room || !player || room.phase !== "playing" || !player.alive) return;
    if (!state || typeof state !== "object") return;

    const now = Date.now();
    if (now - player.lastState < 25) return;
    player.lastState = now;

    const finite = (v, fallback) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;

    player.x = Math.max(-20.3, Math.min(20.3, finite(state.x, player.x)));
    player.z = Math.max(-20.3, Math.min(20.3, finite(state.z, player.z)));
    player.yaw = finite(state.yaw, player.yaw);
    player.pitch = Math.max(-1.35, Math.min(1.35, finite(state.pitch, player.pitch)));

    socket.to(code).emit("playerMoved", {
      id: player.id,
      x: player.x,
      y: 1.7,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch
    });
  });

  socket.on("shoot", aim => fireShot(socket, aim));
  socket.on("reload", () => reloadPlayer(socket));

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Tactical Strike running on port ${PORT}`);
});
```
