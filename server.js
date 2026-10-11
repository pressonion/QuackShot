
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

// Keep these coordinates in sync with mapBlocks in public/index.html.
const COVER = [
  { x: 0, z: -24, w: 50, d: 1, h: 7 },
  { x: 0, z: 24, w: 50, d: 1, h: 7 },
  { x: -24, z: 0, w: 1, d: 50, h: 7 },
  { x: 24, z: 0, w: 1, d: 50, h: 7 },

  { x: -9, z: -13, w: 8, d: 10, h: 7 },
  { x: -9, z: 13, w: 8, d: 10, h: 7 },
  { x: 9, z: -13, w: 8, d: 10, h: 7 },
  { x: 9, z: 13, w: 8, d: 10, h: 7 },

  { x: -19, z: -19, w: 5, d: 5, h: 11 },
  { x: 19, z: -19, w: 5, d: 5, h: 11 },
  { x: -19, z: 19, w: 5, d: 5, h: 11 },
  { x: 19, z: 19, w: 5, d: 5, h: 11 },

  { x: -3.8, z: -5.5, w: 1.2, d: 5, h: 2.3 },
  { x: 3.8, z: 5.5, w: 1.2, d: 5, h: 2.3 },
  { x: -3.8, z: 5.5, w: 1.2, d: 5, h: 2.3 },
  { x: 3.8, z: -5.5, w: 1.2, d: 5, h: 2.3 },

  { x: -15, z: -6, w: 4.5, d: 1.1, h: 2.5 },
  { x: 15, z: 6, w: 4.5, d: 1.1, h: 2.5 },
  { x: -15, z: 6, w: 4.5, d: 1.1, h: 2.5 },
  { x: 15, z: -6, w: 4.5, d: 1.1, h: 2.5 },

  { x: 0, z: -2.7, w: 5.8, d: 1, h: 1.35 },
  { x: 0, z: 2.7, w: 5.8, d: 1, h: 1.35 }
];

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) {
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
    y: p.crouched ? 1.05 : 1.7,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    health: p.health,
    ammo: p.ammo,
    alive: p.alive,
    reloading: p.reloading,
    crouched: p.crouched
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
  if (room) io.to(code).emit("matchState", publicState(room));
}

function chooseTeam(room) {
  const red = teamCount(room, "red");
  const blue = teamCount(room, "blue");
  if (red >= MAX_TEAM_SIZE && blue >= MAX_TEAM_SIZE) return null;
  if (red >= MAX_TEAM_SIZE) return "blue";
  if (blue >= MAX_TEAM_SIZE) return "red";
  return red <= blue ? "red" : "blue";
}

function resetPlayerForRound(player, room) {
  const teamPlayers = [...room.players.values()]
    .filter(p => p.team === player.team)
    .sort((a, b) => a.id.localeCompare(b.id));
  const index = Math.max(0, teamPlayers.findIndex(p => p.id === player.id));
  const z = (index - (teamPlayers.length - 1) / 2) * 2.1;

  player.x = player.team === "red" ? -18 : 18;
  player.z = z;
  player.yaw = player.team === "red" ? -Math.PI / 2 : Math.PI / 2;
  player.pitch = 0;
  player.health = 100;
  player.ammo = MAGAZINE_SIZE;
  player.alive = true;
  player.reloading = false;
  player.crouched = false;
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
  io.to(code).emit("combatMessage", {
    text: `ROUND ${room.roundNumber} - FIGHT!`
  });
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

  const red = teamCount(room, "red");
  const blue = teamCount(room, "blue");

  if (!red || !blue) {
    socket.emit("roomError", "Both teams need at least one player.");
    return;
  }

  if (red > MAX_TEAM_SIZE || blue > MAX_TEAM_SIZE) {
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

  const redPlayers = [...room.players.values()].filter(p => p.team === "red");
  const bluePlayers = [...room.players.values()].filter(p => p.team === "blue");

  if (!redPlayers.length || !bluePlayers.length) return;

  const redAlive = redPlayers.some(p => p.alive);
  const blueAlive = bluePlayers.some(p => p.alive);
  if (redAlive && blueAlive) return;

  let winner = null;
  if (redAlive && !blueAlive) winner = "red";
  if (blueAlive && !redAlive) winner = "blue";

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

    if (!teamCount(current, "red") || !teamCount(current, "blue")) {
      current.phase = "lobby";
      broadcastState(code);
      return;
    }

    startRound(code);
  }, ROUND_DELAY_MS);
}

function rayBoxDistance(origin, direction, b) {
  const min = [b.x - b.w / 2, 0, b.z - b.d / 2];
  const max = [b.x + b.w / 2, b.h, b.z + b.d / 2];
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
    if (t1 > t2) [t1, t2] = [t2, t1];

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMax < tMin) return Infinity;
  }

  if (tMax < 0) return Infinity;
  return tMin >= 0 ? tMin : tMax;
}

function findShotTarget(room, shooter, direction) {
  const origin = {
    x: shooter.x,
    y: shooter.crouched ? 1.05 : 1.7,
    z: shooter.z
  };

  let blockDistance = Infinity;
  for (const b of COVER) {
    blockDistance = Math.min(
      blockDistance,
      rayBoxDistance(origin, direction, b)
    );
  }

  let best = null;
  let bestDistance = Infinity;

  for (const target of room.players.values()) {
    if (target.id === shooter.id || target.team === shooter.team || !target.alive) {
      continue;
    }

    const targetY = target.crouched ? 1.05 : 1.7;
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const horizontalDirSq = direction.x * direction.x + direction.z * direction.z;
    if (horizontalDirSq < 0.0001) continue;

    const t = (dx * direction.x + dz * direction.z) / horizontalDirSq;
    if (t <= 0) continue;

    const hitX = origin.x + direction.x * t;
    const hitZ = origin.z + direction.z * t;

    if (Math.hypot(hitX - target.x, hitZ - target.z) > 0.48) continue;

    const rayDistance = t / Math.sqrt(horizontalDirSq);
    const hitY = origin.y + direction.y * rayDistance;
    const bottom = targetY - 1.0;
    const top = targetY + 0.35;

    if (hitY < bottom || hitY > top) continue;
    if (rayDistance >= bestDistance) continue;

    let zone, damage;
    if (hitY >= targetY + 0.16) {
      zone = "head";
      damage = 40;
    } else if (hitY < targetY - 0.48) {
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
    if (Number.isFinite(aim.pitch)) {
      shooter.pitch = Math.max(-1.25, Math.min(1.25, aim.pitch));
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
    y: shooter.crouched ? 1.05 : 1.7,
    z: shooter.z,
    yaw: shooter.yaw,
    pitch: shooter.pitch
  });

  const result = findShotTarget(room, shooter, direction);
  const response = { ammo: shooter.ammo, reloading: shooter.reloading };

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

    if (!currentRoom || !currentPlayer || currentPlayer.reloadToken !== token) return;

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
    io.to(code).emit("combatMessage", {
      text: "A new host has been selected."
    });
  }

  broadcastState(code);

  if (room.phase === "playing" || room.phase === "between") {
    if (!teamCount(room, "red") || !teamCount(room, "blue")) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      room.roundTimer = null;
      room.phase = "lobby";
      broadcastState(code);
    } else if (room.phase === "playing") {
      checkRoundEnd(code);
    }
  }
}

function joinRoom(socket, roomCode, name) {
  if (typeof roomCode !== "string") return;

  roomCode = roomCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(roomCode)) {
    socket.emit("roomError", "Room codes must be 5 letters or numbers.");
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

  // Rejoining the same room should not remove the room before joining again.
  if (socket.data.roomCode === roomCode && room.players.has(socket.id)) {
    socket.emit("joinedRoom", {
      roomCode,
      id: socket.id,
      hostId: room.hostId,
      state: publicState(room)
    });
    return;
  }

  if (room.players.size >= MAX_PLAYERS) {
    socket.emit("roomError", "This lobby is full (10 players maximum).");
    return;
  }

  leaveCurrentRoom(socket);

  const currentRoom = rooms.get(roomCode);
  if (!currentRoom) {
    socket.emit("roomError", "That room is no longer available.");
    return;
  }

  const team = chooseTeam(currentRoom);
  if (!team) {
    socket.emit("roomError", "Both teams are full.");
    return;
  }

  const player = {
    id: socket.id,
    name: cleanName(name),
    team,
    x: team === "red" ? -18 : 18,
    y: 1.7,
    z: 0,
    yaw: team === "red" ? -Math.PI / 2 : Math.PI / 2,
    pitch: 0,
    health: 100,
    ammo: MAGAZINE_SIZE,
    alive: true,
    reloading: false,
    crouched: false,
    lastState: 0,
    lastShot: 0,
    reloadToken: 0
  };

  currentRoom.players.set(socket.id, player);
  socket.join(roomCode);
  socket.data.roomCode = roomCode;

  socket.emit("joinedRoom", {
    roomCode,
    id: socket.id,
    hostId: currentRoom.hostId,
    state: publicState(currentRoom)
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

    // Host joins the new room; it is not exposed until it has been created.
    const team = "red";
    const player = {
      id: socket.id,
      name: cleanName(name),
      team,
      x: -18,
      y: 1.7,
      z: 0,
      yaw: -Math.PI / 2,
      pitch: 0,
      health: 100,
      ammo: MAGAZINE_SIZE,
      alive: true,
      reloading: false,
      crouched: false,
      lastState: 0,
      lastShot: 0,
      reloadToken: 0
    };

    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("joinedRoom", {
      roomCode: code,
      id: socket.id,
      hostId: room.hostId,
      state: publicState(room)
    });

    broadcastState(code);
    console.log(`${player.name} created room ${code}`);
  });

  socket.on("joinRoom", data => {
    if (!data || typeof data !== "object") return;
    joinRoom(socket, data.roomCode, data.name);
  });

  socket.on("setTeam", data => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);

    if (!room || room.phase !== "lobby" || socket.id !== room.hostId) return;
    if (!data || typeof data.playerId !== "string") return;
    if (!["red", "blue"].includes(data.team)) return;

    const target = room.players.get(data.playerId);
    if (!target || target.team === data.team) return;

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

    player.x = Math.max(-22.5, Math.min(22.5, finite(state.x, player.x)));
    player.z = Math.max(-22.5, Math.min(22.5, finite(state.z, player.z)));
    player.yaw = finite(state.yaw, player.yaw);
    player.pitch = Math.max(-1.25, Math.min(1.25, finite(state.pitch, player.pitch)));
    player.crouched = Boolean(state.crouched);

    socket.to(code).emit("playerMoved", {
      id: player.id,
      x: player.x,
      y: player.crouched ? 1.05 : 1.7,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      crouched: player.crouched
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
