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

const createRoomState = (hostToken, creatorUserId, creatorUsername) => ({
  hostToken,
  creatorUserId,
  creatorUsername,
  participants: [],
  controlRequests: [],
  videoId: "SqcY0GlETPk",
  playState: "paused",
  currentTime: 0,
  cleanupTimer: null,
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
  const cleanRoomId = String(roomId || "").trim().toUpperCase();
  const room = rooms[cleanRoomId];
  if (!room) {
    if (socket.data.roomId === cleanRoomId) {
      socket.data.roomId = null;
    }
    return;
  }

  const userIndex = room.participants.findIndex(
    (user) => user.userId === socket.id
  );

  if (userIndex === -1) {
    socket.leave(cleanRoomId);
    if (socket.data.roomId === cleanRoomId) {
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

  socket.leave(cleanRoomId);
  if (socket.data.roomId === cleanRoomId) {
    socket.data.roomId = null;
  }

  if (notify && user) {
    io.to(cleanRoomId).emit("user_left", {
      username: user.username,
      userId: socket.id,
      participants: room.participants,
    });
    emitControlRequests(cleanRoomId, room);
  }

  if (room.participants.length === 0) {
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => {
      if (rooms[cleanRoomId] && rooms[cleanRoomId].participants.length === 0) {
        delete rooms[cleanRoomId];
        console.log(`Room ${cleanRoomId} deleted after grace period.`);
      }
    }, 5 * 60 * 1000);
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

const handleJoinOrCreate = (socket, { roomId, username, hostToken, action, isCreator }) => {
  const cleanRoomId = String(roomId || "").trim().toUpperCase();
  const cleanUsername = String(username || "").trim();

  if (!cleanRoomId || !cleanUsername) return;

  const previousRoomId = socket.data.roomId;
  if (previousRoomId && previousRoomId !== cleanRoomId) {
    removeSocketFromRoom(socket, previousRoomId, { notify: true });
  }

  let room = rooms[cleanRoomId];

  // 1. Room does not exist yet
  if (!room) {
    // If explicitly joining an existing room, reject with room_not_found
    if (action === "join" && !isCreator && !hostToken) {
      socket.emit("room_not_found", { roomId: cleanRoomId });
      return;
    }

    // Creating the room
    const assignedToken = hostToken || crypto.randomUUID();
    room = createRoomState(assignedToken, socket.id, cleanUsername);
    rooms[cleanRoomId] = room;

    addHost(socket, cleanRoomId, cleanUsername, room);
    return;
  }

  // 2. Room exists: clear any pending cleanup timer
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  // Check if socket already in room
  const alreadyInRoom = room.participants.find(
    (participant) => participant.userId === socket.id
  );
  if (alreadyInRoom) {
    socket.emit("sync_state", {
      playState: room.playState,
      currentTime: room.currentTime,
      videoId: room.videoId,
    });
    return;
  }

  // Check if there is already an active connected Host in room
  const hasActiveHost = room.participants.some((p) => p.role === "Host");

  // Determine whether this user is the legitimate original creator/host:
  // - They provide the matching hostToken
  // - OR, there is no active host and they are the original creator by username or socket, and claiming create/creator
  const tokenMatches = Boolean(hostToken && hostToken === room.hostToken);
  const isOriginalCreatorName = Boolean(
    room.creatorUsername && room.creatorUsername.toLowerCase() === cleanUsername.toLowerCase()
  );
  const isOriginalCreatorSocket = Boolean(
    room.creatorUserId && room.creatorUserId === socket.id
  );

  const isLegitimateHost =
    tokenMatches ||
    (!hasActiveHost && (action === "create" || isCreator === true) && (isOriginalCreatorName || isOriginalCreatorSocket));

  if (isLegitimateHost) {
    room.creatorUserId = socket.id;
    if (!room.creatorUsername) {
      room.creatorUsername = cleanUsername;
    }
    addHost(socket, cleanRoomId, cleanUsername, room);
  } else {
    // Any user joining an existing room is strictly a Participant
    addParticipant(socket, cleanRoomId, cleanUsername, room);
  }
};

app.get("/", (req, res) => {
  res.send("Watch Party Server is running");
});

// JOIN ROOM
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("create_room", (data) => {
    const { roomId, username, hostToken } = data || {};
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const cleanUsername = String(username || "").trim();

    if (!cleanRoomId || !cleanUsername || !hostToken) return;

    let room = rooms[cleanRoomId];
    if (room && room.hostToken !== hostToken) {
      socket.emit("room_creation_failed", {
        roomId: cleanRoomId,
        message: "That room code is already in use. Please create another room.",
      });
      return;
    }

    handleJoinOrCreate(socket, {
      ...data,
      roomId: cleanRoomId,
      username: cleanUsername,
      hostToken,
      action: "create",
      isCreator: true,
    });
  });

  socket.on("join_room", (data) => {
    const { roomId, username } = data || {};
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const cleanUsername = String(username || "").trim();

    if (!cleanRoomId || !cleanUsername) return;

    handleJoinOrCreate(socket, {
      ...data,
      roomId: cleanRoomId,
      username: cleanUsername,
    });
  });

  socket.on("request_control", ({ roomId, action, value }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
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
    emitControlRequests(cleanRoomId, room);
  });

  socket.on("review_control_request", ({ roomId, requestId, approved }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
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

      emitSyncState(cleanRoomId, room);
    }

    io.to(request.userId).emit("control_request_status", {
      status: approved ? "approved" : "rejected",
      message: approved ? "Your request was approved." : "Your request was declined.",
    });
    emitControlRequests(cleanRoomId, room);
  });

  // PLAY
  socket.on("play", ({ roomId, currentTime }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (!room || !Number.isFinite(currentTime) || currentTime < 0) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user || !canControl(user)) return;

    room.playState = "playing";
    room.currentTime = currentTime;

    socket.to(cleanRoomId).emit("sync_state", {
      playState: "playing",
      currentTime,
      videoId: room.videoId,
    });
  });

  // PAUSE
  socket.on("pause", ({ roomId, currentTime }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (!room || !Number.isFinite(currentTime) || currentTime < 0) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user || !canControl(user)) return;

    room.playState = "paused";
    room.currentTime = currentTime;

    socket.to(cleanRoomId).emit("sync_state", {
      playState: "paused",
      currentTime,
      videoId: room.videoId,
    });
  });

  // SEEK
  socket.on("seek", ({ roomId, time }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (!room || !Number.isFinite(time) || time < 0) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user || !canControl(user)) return;

    room.currentTime = time;

    socket.to(cleanRoomId).emit("sync_state", {
      playState: room.playState,
      currentTime: time,
      videoId: room.videoId,
    });
  });

  // CHANGE VIDEO
  socket.on("change_video", ({ roomId, videoId }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (!room || typeof videoId !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;

    const user = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!user || !canControl(user)) return;

    room.videoId = videoId;
    room.playState = "paused";
    room.currentTime = 0;

    io.to(cleanRoomId).emit("sync_state", {
      playState: "paused",
      currentTime: 0,
      videoId,
    });
  });

  // ASSIGN ROLE
  socket.on("assign_role", ({ roomId, userId, role }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (!room) return;

    const host = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!host || host.role !== "Host") return;

    const user = room.participants.find(
      (participant) => participant.userId === userId
    );

    if (!user || userId === socket.id) return;

    if (role !== "Participant" && role !== "Moderator") return;

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

    console.log(`${user.username} is now ${role}`);

    io.to(cleanRoomId).emit("role_assigned", {
      participants: room.participants,
    });
    emitControlRequests(cleanRoomId, room);
  });

  // REMOVE PARTICIPANT
  socket.on("remove_participant", ({ roomId, userId }) => {
    const cleanRoomId = String(roomId || "").trim().toUpperCase();
    const room = rooms[cleanRoomId];
    if (!room) return;

    const host = room.participants.find(
      (participant) => participant.userId === socket.id
    );

    if (!host || host.role !== "Host") return;

    const userIndex = room.participants.findIndex(
      (participant) => participant.userId === userId
    );

    if (userIndex === -1 || userId === socket.id) return;

    const removedUser = room.participants[userIndex];

    room.participants.splice(userIndex, 1);
    room.controlRequests = room.controlRequests.filter(
      (request) => request.userId !== userId
    );

    console.log(
      `${removedUser.username} was removed from room ${cleanRoomId} by Host`
    );

    io.to(userId).emit("participant_removed", {
      roomId: cleanRoomId,
      userId,
    });

    io.to(cleanRoomId).emit("user_left", {
      participants: room.participants,
    });
    emitControlRequests(cleanRoomId, room);

    const removedSocket = io.sockets.sockets.get(userId);
    if (removedSocket) {
      removedSocket.leave(cleanRoomId);
      removedSocket.data.roomId = null;
    }
  });

  // LEAVE ROOM
  socket.on("leave_room", ({ roomId }) => {
    const cleanRoomId = String(roomId || socket.data.roomId || "").trim().toUpperCase();
    if (!cleanRoomId) return;

    removeSocketFromRoom(socket, cleanRoomId, { notify: true });
    socket.emit("room_left", {
      roomId: cleanRoomId,
      userId: socket.id,
    });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const cleanRoomId = String(roomId).trim().toUpperCase();
    removeSocketFromRoom(socket, cleanRoomId, { notify: true });
  });
});

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(
    `Server running on port ${port}`
  );
});