const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();

app.use(cors());

const rooms = {};

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

const createRoomState = (hostToken, creatorUserId) => ({
  hostToken,
  creatorUserId,
  participants: [],
  controlRequests: [],
  videoId: "SqcY0GlETPk",
  playState: "paused",
  currentTime: 0,
});

const canControl = (participant) =>
  participant?.role === "Host" || participant?.role === "Moderator";

const emitControlRequests = (roomId, room) => {
  const requests = room.controlRequests;

  room.participants.filter(canControl).forEach((participant) => {
    io.to(participant.userId).emit("control_requests", { requests });
  });
};

const emitSyncState = (roomId, room) => {
  io.to(roomId).emit("sync_state", {
    playState: room.playState,
    currentTime: room.currentTime,
    videoId: room.videoId,
  });
};

const removeSocketFromRoom = (socket, roomId, { notify = true } = {}) => {
  const room = rooms[roomId];
  if (!room) {
    if (socket.data.roomId === roomId) {
      socket.data.roomId = null;
    }
    return;
  }

  const userIndex = room.participants.findIndex(
    (user) => user.userId === socket.id
  );

  if (userIndex === -1) {
    socket.leave(roomId);
    if (socket.data.roomId === roomId) {
      socket.data.roomId = null;
    }
    return;
  }

  const [user] = room.participants.splice(userIndex, 1);
  if (room.creatorUserId === socket.id) {
    room.creatorUserId = null;
  }
  room.controlRequests = room.controlRequests.filter(
    (request) => request.userId !== socket.id
  );

  socket.leave(roomId);
  if (socket.data.roomId === roomId) {
    socket.data.roomId = null;
  }

  if (notify && user) {
    io.to(roomId).emit("user_left", {
      username: user.username,
      userId: socket.id,
      participants: room.participants,
    });
    emitControlRequests(roomId, room);
  }

  if (room.participants.length === 0) {
    delete rooms[roomId];
  }
};

const addRoomMember = (socket, roomId, username, room, role) => {
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

  if (canControl(room.participants.at(-1))) {
    emitControlRequests(roomId, room);
  }

  socket.emit("sync_state", {
    playState: room.playState,
    currentTime: room.currentTime,
    videoId: room.videoId,
  });
};

const addHost = (socket, roomId, username, room) =>
  addRoomMember(socket, roomId, username, room, "Host");

const addParticipant = (socket, roomId, username, room) =>
  addRoomMember(socket, roomId, username, room, "Participant");

app.get("/", (req, res) => {
  res.send("Watch Party Server is running");
});

// JOIN ROOM
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("create_room", ({ roomId, username, hostToken }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const cleanUsername = String(username || "").trim();

    if (!cleanRoomId || !cleanUsername || !hostToken) return;

    const previousRoomId = socket.data.roomId;
    if (previousRoomId && previousRoomId !== cleanRoomId) {
      removeSocketFromRoom(socket, previousRoomId, { notify: true });
    }

    let room = rooms[cleanRoomId];

    if (room && room.hostToken !== hostToken) {
      socket.emit("room_creation_failed", {
        roomId: cleanRoomId,
        message: "That room code is already in use. Please create another room.",
      });
      return;
    }

    if (!room) {
      room = createRoomState(hostToken, socket.id);
      rooms[cleanRoomId] = room;
    }

    if (room.participants.some((participant) => participant.userId === socket.id)) {
      socket.emit("sync_state", {
        playState: room.playState,
        currentTime: room.currentTime,
        videoId: room.videoId,
      });
      return;
    }

    room.creatorUserId = socket.id;
    addHost(socket, cleanRoomId, cleanUsername, room);
  });

  socket.on("join_room", ({ roomId, username }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const cleanUsername = String(username || "").trim();

    if (!cleanRoomId || !cleanUsername) return;

    const previousRoomId = socket.data.roomId;
    if (previousRoomId && previousRoomId !== cleanRoomId) {
      removeSocketFromRoom(socket, previousRoomId, { notify: true });
    }

    const room = rooms[cleanRoomId];
    if (!room) {
      socket.emit("room_not_found", { roomId: cleanRoomId });
      return;
    }

    if (room.participants.some((participant) => participant.userId === socket.id)) {
      socket.emit("sync_state", {
        playState: room.playState,
        currentTime: room.currentTime,
        videoId: room.videoId,
      });
      return;
    }

    addParticipant(socket, cleanRoomId, cleanUsername, room);
  });

  socket.on("request_control", ({ roomId, action, value }) => {
    const room = rooms[roomId];
    const participant = room?.participants.find(
      (user) => user.userId === socket.id
    );

    if (!room || !participant || participant.role !== "Participant") return;

    if (room.controlRequests.some((request) => request.userId === socket.id)) {
      socket.emit("control_request_status", {
        status: "error",
        message: "You already have a request awaiting review.",
      });
      return;
    }

    const validAction = ["play", "pause", "seek", "change_video"].includes(action);
    const validValue = action === "change_video"
      ? typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value)
      : Number.isFinite(value) && value >= 0;

    if (!validAction || !validValue) {
      socket.emit("control_request_status", {
        status: "error",
        message: "That control request is invalid.",
      });
      return;
    }

    const request = {
      requestId: crypto.randomUUID(),
      userId: socket.id,
      username: participant.username,
      action,
      value,
    };

    room.controlRequests.push(request);
    socket.emit("control_request_status", {
      status: "pending",
      message: "Your request is waiting for Host or Moderator approval.",
    });
    emitControlRequests(roomId, room);
  });

  socket.on("review_control_request", ({ roomId, requestId, approved }) => {
    const room = rooms[roomId];
    const reviewer = room?.participants.find(
      (user) => user.userId === socket.id
    );

    if (!room || !canControl(reviewer) || typeof approved !== "boolean") return;

    const requestIndex = room.controlRequests.findIndex(
      (request) => request.requestId === requestId
    );
    if (requestIndex === -1) return;

    const [request] = room.controlRequests.splice(requestIndex, 1);

    if (approved) {
      if (request.action === "play" || request.action === "pause") {
        room.playState = request.action === "play" ? "playing" : "paused";
        room.currentTime = request.value;
      } else if (request.action === "seek") {
        room.currentTime = request.value;
      } else if (request.action === "change_video") {
        room.videoId = request.value;
        room.playState = "paused";
        room.currentTime = 0;
      }

      emitSyncState(roomId, room);
    }

    io.to(request.userId).emit("control_request_status", {
      status: approved ? "approved" : "rejected",
      message: approved ? "Your request was approved." : "Your request was declined.",
    });
    emitControlRequests(roomId, room);
  });

  // PLAY
  socket.on("play", ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room || !Number.isFinite(currentTime) || currentTime < 0) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (!canControl(user)) return;

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
    if (!room || !Number.isFinite(currentTime) || currentTime < 0) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (!canControl(user)) return;

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
    if (!room || !Number.isFinite(time) || time < 0) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (!canControl(user)) return;

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
    if (!room || typeof videoId !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user) return;

    if (!canControl(user)) return;

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

      if (!user || userId === socket.id) return;

      if (
        role !== "Participant" &&
        role !== "Moderator"
      ) {
        return;
      }

      user.role = role;

      if (role === "Moderator") {
        room.controlRequests = room.controlRequests.filter(
          (request) => request.userId !== userId
        );
        io.to(userId).emit("control_request_status", {
          status: "error",
          message: "Your role changed; you can now control playback directly.",
        });
      }

      console.log(
        `${user.username} is now ${role}`
      );

      io.to(roomId).emit("role_assigned", {
        participants: room.participants,
      });
      emitControlRequests(roomId, room);
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

      if (userIndex === -1 || userId === socket.id) return;

      const removedUser =
        room.participants[userIndex];

      room.participants.splice(userIndex, 1);
      room.controlRequests = room.controlRequests.filter(
        (request) => request.userId !== userId
      );

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
      emitControlRequests(roomId, room);

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
    room.controlRequests = room.controlRequests.filter(
      (request) => request.userId !== socket.id
    );

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
    emitControlRequests(roomId, room);

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
    room.controlRequests = room.controlRequests.filter(
      (request) => request.userId !== socket.id
    );

    io.to(roomId).emit("user_left", {
      username: user.username,
      userId: socket.id,
      participants: room.participants,
    });
    emitControlRequests(roomId, room);

    if (room.participants.length === 0) {
      delete rooms[roomId];
    }
  });
});

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(
    `Server running on port ${port}`
  );
});