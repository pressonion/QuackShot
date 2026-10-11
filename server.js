
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ online: true, game: "Simple Multiplayer FPS" });
});

const rooms = new Map();

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

function publicPlayers(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];

  return [...room.values()].map(player => ({
    id: player.id,
    name: player.name,
    color: player.color,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch
  }));
}

function broadcastPlayers(roomCode) {
  if (!rooms.has(roomCode)) return;
  io.to(roomCode).emit("players", publicPlayers(roomCode));
}

function leaveCurrentRoom(socket) {
  const oldCode = socket.data.roomCode;
  if (!oldCode) return;

  const room = rooms.get(oldCode);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) {
      rooms.delete(oldCode);
    } else {
      broadcastPlayers(oldCode);
    }
  }

  socket.leave(oldCode);
  socket.data.roomCode = null;
}

function joinRoom(socket, roomCode, name) {
  if (typeof roomCode !== "string") return;
  roomCode = roomCode.trim().toUpperCase();

  if (!/^[A-Z0-9]{5}$/.test(roomCode)) {
    socket.emit("roomError", "Room codes must be 5 letters or numbers.");
    return;
  }

  if (!rooms.has(roomCode)) {
    socket.emit("roomError", "That room doesn't exist. Create it first.");
    return;
  }

  if (rooms.get(roomCode).size >= 12) {
    socket.emit("roomError", "This room is full (12 players maximum).");
    return;
  }

  leaveCurrentRoom(socket);

  const room = rooms.get(roomCode);
  const player = {
    id: socket.id,
    name: cleanName(name),
    color: ["#42e8ff", "#ff62d5", "#a4ff5c", "#ffbd4a", "#b38aff"][
      Math.floor(Math.random() * 5)
    ],
    x: (Math.random() - 0.5) * 8,
    y: 1.7,
    z: (Math.random() - 0.5) * 8,
    yaw: 0,
    pitch: 0,
    lastState: 0,
    lastShot: 0
  };

  room.set(socket.id, player);
  socket.join(roomCode);
  socket.data.roomCode = roomCode;

  socket.emit("joinedRoom", {
    roomCode,
    id: socket.id,
    players: publicPlayers(roomCode)
  });

  broadcastPlayers(roomCode);
  console.log(`${player.name} joined room ${roomCode}`);
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("createRoom", name => {
    leaveCurrentRoom(socket);
    const code = makeRoomCode();
    rooms.set(code, new Map());
    socket.data.roomCode = null;
    joinRoom(socket, code, name);
  });

  socket.on("joinRoom", data => {
    if (!data || typeof data !== "object") return;
    joinRoom(socket, data.roomCode, data.name);
  });

  socket.on("playerState", state => {
    const code = socket.data.roomCode;
    if (!code || !state || typeof state !== "object") return;

    const room = rooms.get(code);
    const player = room && room.get(socket.id);
    if (!player) return;

    const now = Date.now();
    if (now - player.lastState < 25) return;
    player.lastState = now;

    const finite = (v, fallback) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;

    player.x = Math.max(-48, Math.min(48, finite(state.x, player.x)));
    player.y = 1.7;
    player.z = Math.max(-48, Math.min(48, finite(state.z, player.z)));
    player.yaw = finite(state.yaw, player.yaw);
    player.pitch = Math.max(-1.5, Math.min(1.5, finite(state.pitch, player.pitch)));

    socket.to(code).emit("playerMoved", {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch
    });
  });

  socket.on("shoot", () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    const player = room && room.get(socket.id);
    if (!player) return;

    const now = Date.now();
    if (now - player.lastShot < 120) return;
    player.lastShot = now;

    // Cosmetic shooting only. This event never deals damage.
    socket.to(code).emit("playerShot", {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch
    });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Multiplayer FPS running on port ${PORT}`);
});
