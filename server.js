
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.get("/", (req, res) => {
  res.send("FPS Multiplayer Server is running!");
});

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.emit("serverMessage", "Connected to the FPS server!");

  socket.on("joinRoom", (roomCode) => {
    if (typeof roomCode !== "string") return;

    roomCode = roomCode.trim().toUpperCase();

    if (!/^[A-Z0-9]{4,12}$/.test(roomCode)) return;

    // Leave the player's previous game rooms.
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }

    socket.join(roomCode);

    io.to(roomCode).emit("playerList", {
      room: roomCode,
      players: [...(io.sockets.adapter.rooms.get(roomCode) || [])]
    });

    console.log(socket.id, "joined room", roomCode);
  });

  socket.on("gameMessage", (data) => {
    if (!data || typeof data.room !== "string") return;

    const roomCode = data.room.trim().toUpperCase();

    if (!/^[A-Z0-9]{4,12}$/.test(roomCode)) return;
    if (!socket.rooms.has(roomCode)) return;

    // Relay a game event to the other players in this room.
    socket.to(roomCode).emit("gameMessage", {
      playerId: socket.id,
      data
    });
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);

    for (const room of socket.rooms) {
      if (room !== socket.id) {
        io.to(room).emit("playerList", {
          room,
          players: [...(io.sockets.adapter.rooms.get(room) || [])]
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FPS server running on port ${PORT}`);
});
