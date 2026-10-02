const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors());

const rooms = {};

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const createRoomState = (hostToken) => ({
  hostToken,
  participants: [],
  videoId: "SqcY0GlETPk",
  playState: "paused",
  currentTime: 0,
});

const addParticipant = (socket, roomId, username, room, role) => {
  const existingUser = room.participants.find(
    (user) => user.userId === socket.id
  );

  if (existingUser) return;

  room.participants.push({
    userId: socket.id,
    username,
    role,
  });

  socket.join(roomId);
  socket.data.roomId = roomId;
  socket.data.username = username;

  console.log(`${username} joined room ${roomId} as ${role}`);

  io.to(roomId).emit("user_joined", {
    participants: room.participants,
  });

  socket.emit("sync_state", {
    playState: room.playState,
    currentTime: room.currentTime,
    videoId: room.videoId,
  });
};

app.get("/", (req, res) => {
  res.send("Watch Party Server is running");
});

// JOIN ROOM
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("create_room", ({ roomId, username, hostToken }) => {
    if (!roomId || !username || !hostToken) return;

    let room = rooms[roomId];

    if (room && room.hostToken !== hostToken) return;

    if (!room) {
      room = createRoomState(hostToken);
      rooms[roomId] = room;
    }

    addParticipant(socket, roomId, username, room, "Host");
  });

  socket.on("join_room", ({ roomId, username }) => {
    if (!roomId || !username) return;

    const room = rooms[roomId];
    if (!room) {
      socket.emit("room_not_found", { roomId });
      return;
    }

    addParticipant(socket, roomId, username, room, "Participant");
  });

  // PLAY
  socket.on("play", ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (
      user.role !== "Host" &&
      user.role !== "Moderator"
    ) {
      return;
    }

    room.playState = "playing";
    room.currentTime = currentTime;

    socket.to(roomId).emit("sync_state", {
      playState: "playing",
      currentTime,
      videoId: room.videoId,
    });
  });

  // PAUSE
  socket.on("pause", ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (
      user.role !== "Host" &&
      user.role !== "Moderator"
    ) {
      return;
    }

    room.playState = "paused";
    room.currentTime = currentTime;

    socket.to(roomId).emit("sync_state", {
      playState: "paused",
      currentTime,
      videoId: room.videoId,
    });
  });

  // SEEK
  socket.on("seek", ({ roomId, time }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (
      user.role !== "Host" &&
      user.role !== "Moderator"
    ) {
      return;
    }

    room.currentTime = time;

    socket.to(roomId).emit("sync_state", {
      playState: room.playState,
      currentTime: time,
      videoId: room.videoId,
    });
  });

  // CHANGE VIDEO
  socket.on("change_video", ({ roomId, videoId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (
      user.role !== "Host" &&
      user.role !== "Moderator"
    ) {
      return;
    }

    room.videoId = videoId;
    room.playState = "paused";
    room.currentTime = 0;

    io.to(roomId).emit("sync_state", {
      playState: "paused",
      currentTime: 0,
      videoId,
    });
  });

  // ASSIGN ROLE
  socket.on(
    "assign_role",
    ({ roomId, userId, role }) => {
      const room = rooms[roomId];
      if (!room) return;

      const host = room.participants.find(
        (participant) => participant.userId === socket.id
      );

      if (!host || host.role !== "Host") {
        return;
      }

      const user = room.participants.find(
        (participant) => participant.userId === userId
      );

      if (!user) return;

      if (
        role !== "Participant" &&
        role !== "Moderator"
      ) {
        return;
      }

      user.role = role;

      console.log(
        `${user.username} is now ${role}`
      );

      io.to(roomId).emit("role_assigned", {
        participants: room.participants,
      });
    }
  );

  // REMOVE PARTICIPANT
  socket.on(
    "remove_participant",
    ({ roomId, userId }) => {
      const room = rooms[roomId];
      if (!room) return;

      const host = room.participants.find(
        (participant) => participant.userId === socket.id
      );

      if (!host || host.role !== "Host") {
        return;
      }

      const userIndex = room.participants.findIndex(
        (participant) => participant.userId === userId
      );

      if (userIndex === -1) return;

      const removedUser =
        room.participants[userIndex];

      room.participants.splice(userIndex, 1);

      console.log(
        `${removedUser.username} was removed from room ${roomId} by Host`
      );

      io.to(userId).emit("participant_removed", {
        roomId,
        userId,
      });

      io.to(roomId).emit("user_left", {
        participants: room.participants,
      });

      const removedSocket =
        io.sockets.sockets.get(userId);

      if (removedSocket) {
        removedSocket.leave(roomId);
        removedSocket.data.roomId = null;
      }
    }
  );

  // LEAVE ROOM
  socket.on("leave_room", ({ roomId }) => {
    const room = rooms[roomId];

    if (!room) return;

    const userIndex = room.participants.findIndex(
      (user) => user.userId === socket.id
    );

    if (userIndex === -1) return;

    const user = room.participants[userIndex];

    room.participants.splice(userIndex, 1);

    socket.leave(roomId);

    socket.data.roomId = null;

    socket.emit("room_left", {
      roomId,
      userId: socket.id,
    });

    io.to(roomId).emit("user_left", {
      username: user.username,
      userId: socket.id,
      participants: room.participants,
    });

    console.log(
      `${user.username} left room ${roomId}`
    );

    if (room.participants.length === 0) {
      delete rooms[roomId];

      console.log(
        `Room ${roomId} deleted`
      );
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log(
      "User disconnected:",
      socket.id
    );

    const roomId = socket.data.roomId;

    if (!roomId || !rooms[roomId]) {
      return;
    }

    const room = rooms[roomId];

    const userIndex = room.participants.findIndex(
      (user) => user.userId === socket.id
    );

    if (userIndex === -1) return;

    const user = room.participants[userIndex];

    room.participants.splice(userIndex, 1);

    io.to(roomId).emit("user_left", {
      username: user.username,
      userId: socket.id,
      participants: room.participants,
    });

    if (room.participants.length === 0) {
      delete rooms[roomId];
    }
  });
});

server.listen(5000, () => {
  console.log(
    "Server running on http://localhost:5000"
  );
});