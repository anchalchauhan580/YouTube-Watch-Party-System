import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import YouTube from "react-youtube";
import "./App.css";

const socket = io(
  import.meta.env.VITE_SOCKET_URL ||
    (import.meta.env.DEV ? "http://localhost:5000" : window.location.origin)
);

type Participant = {
  userId: string;
  username: string;
  role: string;
};

type SyncData = {
  playState: string;
  currentTime: number;
  videoId: string;
};

type ControlRequest = {
  requestId: string;
  userId: string;
  username: string;
  action: "play" | "pause" | "seek" | "change_video";
  value: number | string;
};

type YouTubePlayer = {
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo: (time: number, allowSeekAhead?: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
};

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = String(safeSeconds % 60).padStart(2, "0");

  return `${minutes}:${remainder}`;
};

function App() {
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinUsername, setJoinUsername] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [controlRequests, setControlRequests] = useState<ControlRequest[]>([]);
  const [requestedSeekTime, setRequestedSeekTime] = useState("");
  const [controlRequestMessage, setControlRequestMessage] = useState("");
  const [isControlRequestPending, setIsControlRequestPending] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [videoId, setVideoId] = useState("SqcY0GlETPk");
  const [videoUrl, setVideoUrl] = useState("");

  // UI-only states
  const [activeTab, setActiveTab] = useState<"create" | "join">("create");
  const [copied, setCopied] = useState(false);
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(socket.connected);

  const playerRef = useRef<YouTubePlayer | null>(null);

  const lastTimeRef = useRef(0);
  const playerStateRef = useRef(2);

  const seekTimerRef = useRef<number | null>(null);
  const playbackUiTimerRef = useRef<number | null>(null);
  const pendingSyncRef = useRef<SyncData | null>(null);

  const roomIdRef = useRef("");
  const roomHostTokenRef = useRef<string | null>(null);
  const videoIdRef = useRef(videoId);

  const canControlRef = useRef(false);

  // Remote Play/Pause event ko ignore karne ke liye
  const remoteStateLockRef = useRef<number | null>(null);

  // Remote seek ko local seek samajhne se rokne ke liye
  const remoteSeekLockRef = useRef(false);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    videoIdRef.current = videoId;
  }, [videoId]);

  const currentUser = participants.find(
    (user) => user.userId === socket.id
  );

  const currentRole = currentUser?.role;

  const isHost = currentRole === "Host";

  const canControl =
    currentRole === "Host" ||
    currentRole === "Moderator";

  useEffect(() => {
    canControlRef.current = canControl;
  }, [canControl]);

  const requestControl = (
    action: ControlRequest["action"],
    value: number | string
  ) => {
    if (!roomId || !isConnected || currentRole !== "Participant") return;

    setControlRequestMessage("Sending request...");
    setIsControlRequestPending(true);
    socket.emit("request_control", {
      roomId: roomIdRef.current,
      action,
      value,
    });
  };

  const reviewControlRequest = (requestId: string, approved: boolean) => {
    if (!roomId || !canControl) return;

    socket.emit("review_control_request", {
      roomId: roomIdRef.current,
      requestId,
      approved,
    });
  };

  const togglePlayback = () => {
    if (!canControl || !playerRef.current) return;

    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  };

  const seekPlayback = (time: number) => {
    if (!canControl || !playerRef.current) return;

    playerRef.current.seekTo(time, true);
    lastTimeRef.current = time;
    setPlaybackTime(time);
  };

  const publishPlaybackSeek = () => {
    if (!canControl || !playerRef.current || !roomIdRef.current) return;

    const time = playerRef.current.getCurrentTime();
    lastTimeRef.current = time;
    socket.emit("seek", { roomId: roomIdRef.current, time });
  };

  // Track socket connection for UI indicator
  useEffect(() => {
    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
    };
  }, []);

  // ---------------- CREATE ROOM ----------------

  const createRoom = () => {
    if (!username.trim()) {
      alert("Please enter your name");
      return;
    }

    const newRoomId = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

    const name = username.trim();
    const hostToken = crypto.randomUUID();

    setRoomId(newRoomId);
    roomIdRef.current = newRoomId;
    roomHostTokenRef.current = hostToken;
    setParticipants([]);
    setControlRequests([]);
    setControlRequestMessage("");
    setIsControlRequestPending(false);

    socket.emit("create_room", {
      roomId: newRoomId,
      username: name,
      hostToken,
    });
  };

  // ---------------- JOIN ROOM ----------------

  const joinRoom = () => {
    if (!joinRoomId.trim() || !joinUsername.trim()) {
      alert("Please enter room code and name");
      return;
    }

    const roomCode = joinRoomId.trim().toUpperCase();
    const name = joinUsername.trim();

    setRoomId(roomCode);
    roomIdRef.current = roomCode;
    roomHostTokenRef.current = null;
    setParticipants([]);
    setControlRequests([]);
    setControlRequestMessage("");
    setIsControlRequestPending(false);

    socket.emit("join_room", {
      roomId: roomCode,
      username: name,
    });
  };

  // ---------------- YOUTUBE VIDEO ID ----------------

  const getYouTubeVideoId = (url: string) => {
    try {
      const parsedUrl = new URL(url);

      if (parsedUrl.hostname.includes("youtube.com")) {
        return parsedUrl.searchParams.get("v");
      }

      if (parsedUrl.hostname === "youtu.be") {
        return parsedUrl.pathname.substring(1);
      }

      return null;
    } catch {
      return null;
    }
  };

  // ---------------- CHANGE VIDEO ----------------

  const changeVideo = () => {
    if (!roomId) {
      alert("Please create or join a room first");
      return;
    }

    if (!canControl && currentRole !== "Participant") {
      alert("Only Host or Moderator can change the video");
      return;
    }

    if (!videoUrl.trim()) {
      alert("Please enter a YouTube URL");
      return;
    }

    const newVideoId = getYouTubeVideoId(videoUrl.trim());

    if (!newVideoId) {
      alert("Please enter a valid YouTube URL");
      return;
    }

    if (!canControl) {
      requestControl("change_video", newVideoId);
      setVideoUrl("");
      return;
    }

    socket.emit("change_video", {
      roomId: roomIdRef.current,
      videoId: newVideoId,
    });

    setVideoId(newVideoId);

    lastTimeRef.current = 0;
    playerStateRef.current = 2;

    remoteStateLockRef.current = null;
    remoteSeekLockRef.current = false;

    setVideoUrl("");
  };

  // ---------------- ASSIGN ROLE ----------------

  const assignRole = (
    userId: string,
    role: string
  ) => {
    if (!roomId || !isHost) {
      return;
    }

    socket.emit("assign_role", {
      roomId: roomIdRef.current,
      userId,
      role,
    });
  };

  // ---------------- REMOVE PARTICIPANT ----------------

  const removeParticipant = (userId: string) => {
    if (!roomId || !isHost) {
      return;
    }

    console.log("REMOVE BUTTON CLICKED", {
      roomId: roomIdRef.current,
      userId,
    });

    socket.emit("remove_participant", {
      roomId: roomIdRef.current,
      userId,
    });
  };

  // ---------------- LEAVE ROOM ----------------

  const leaveRoom = () => {
    if (window.confirm("Are you sure you want to leave this watch party?")) {
      setRoomId("");
      setParticipants([]);
      setControlRequests([]);
      setControlRequestMessage("");
      setIsControlRequestPending(false);
      roomIdRef.current = "";
      roomHostTokenRef.current = null;
      playerRef.current = null;
      pendingSyncRef.current = null;
      socket.disconnect();
      socket.connect();
    }
  };

  // ---------------- COPY ROOM CODE ----------------

  const copyRoomCode = () => {
    if (!roomId) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(roomId).catch(() => {
        fallbackCopy(roomId);
      });
    } else {
      fallbackCopy(roomId);
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const fallbackCopy = (text: string) => {
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  };

  // ---------------- AVATAR COLOR PALETTE ----------------

  const getAvatarColor = (name: string, role: string) => {
    if (role === "Host") {
      return { bg: "#fef3c7", text: "#92400e", border: "#fde68a" };
    }
    if (role === "Moderator") {
      return { bg: "#e0f2fe", text: "#0369a1", border: "#bae6fd" };
    }

    const palettes = [
      { bg: "#ede9fe", text: "#6d28d9", border: "#ddd6fe" },
      { bg: "#dcfce7", text: "#15803d", border: "#bbf7d0" },
      { bg: "#fae8ff", text: "#a21caf", border: "#f5d0fe" },
      { bg: "#ffedd5", text: "#c2410c", border: "#fed7aa" },
      { bg: "#f1f5f9", text: "#334155", border: "#cbd5e1" },
    ];

    let sum = 0;
    for (let i = 0; i < (name || "").length; i++) {
      sum += name.charCodeAt(i);
    }
    return palettes[sum % palettes.length];
  };

  // ---------------- APPLY SYNC ----------------

  const applySyncState = (data: SyncData) => {
    if (!data) {
      return;
    }

    setPlaybackTime(data.currentTime);
    setIsPlaying(data.playState === "playing");

    // ---------------- DIFFERENT VIDEO ----------------

    if (
      data.videoId &&
      data.videoId !== videoIdRef.current
    ) {
      pendingSyncRef.current = data;

      setVideoId(data.videoId);

      lastTimeRef.current = 0;
      playerStateRef.current = 2;

      remoteStateLockRef.current = null;
      remoteSeekLockRef.current = false;

      return;
    }

    // ---------------- PLAYER NOT READY ----------------

    if (!playerRef.current) {
      pendingSyncRef.current = data;
      return;
    }

    const player = playerRef.current;

    const currentTime = player.getCurrentTime();

    const timeDifference = Math.abs(
      currentTime - data.currentTime
    );

    // ---------------- REMOTE STATE LOCK ----------------

    if (data.playState === "playing") {
      remoteStateLockRef.current = 1;
    }

    if (data.playState === "paused") {
      remoteStateLockRef.current = 2;
    }

    // ---------------- REMOTE SEEK LOCK ----------------

    remoteSeekLockRef.current = true;

    /*
      Normal Play/Pause ke time har baar seekTo nahi karna.
      Sirf tab seek karo jab time difference significant ho.
    */

    if (timeDifference > 0.7) {
      player.seekTo(data.currentTime, true);
      lastTimeRef.current = data.currentTime;
    } else {
      lastTimeRef.current = currentTime;
    }

    // ---------------- PLAY ----------------

    if (data.playState === "playing") {
      playerStateRef.current = 1;

      player.playVideo();
    }

    // ---------------- PAUSE ----------------

    if (data.playState === "paused") {
      playerStateRef.current = 2;

      player.pauseVideo();
    }

    // Remote seek protection
    window.setTimeout(() => {
      remoteSeekLockRef.current = false;
    }, 700);

    // Remote Play/Pause events protection
    window.setTimeout(() => {
      remoteStateLockRef.current = null;
    }, 2500);
  };

  // ---------------- SOCKET EVENTS ----------------

  useEffect(() => {
    const handleUserJoined = (data: {
      participants: Participant[];
    }) => {
      setParticipants(data.participants);
    };

    const handleUserLeft = (data: {
      participants: Participant[];
    }) => {
      setParticipants(data.participants);
    };

    const handleRoleAssigned = (data: {
      participants: Participant[];
    }) => {
      setParticipants(data.participants);
    };

    const handleControlRequests = (data: { requests: ControlRequest[] }) => {
      setControlRequests(data.requests);
    };

    const handleControlRequestStatus = (data: {
      status: string;
      message: string;
    }) => {
      setControlRequestMessage(data.message);
      setIsControlRequestPending(data.status === "pending");
    };

    const handleSyncState = (data: SyncData) => {
      console.log("SYNC STATE RECEIVED:", data);

      applySyncState(data);
    };

    // ---------------- PARTICIPANT REMOVED ----------------

    const handleParticipantRemoved = (data: {
      roomId: string;
      userId: string;
    }) => {
      if (data.userId !== socket.id) {
        return;
      }

      alert("You have been removed from the room");

      roomIdRef.current = "";
      setRoomId("");
      roomHostTokenRef.current = null;

      setParticipants([]);
      setControlRequests([]);

      playerRef.current = null;
      pendingSyncRef.current = null;

      remoteStateLockRef.current = null;
      remoteSeekLockRef.current = false;

      lastTimeRef.current = 0;
      playerStateRef.current = 2;
    };

    const handleReconnect = () => {
      console.log("Socket reconnected");

      const name =
        username.trim() ||
        joinUsername.trim();

      if (
        roomIdRef.current &&
        name
      ) {
        const hostToken = roomHostTokenRef.current;

        if (hostToken) {
          socket.emit("create_room", {
            roomId: roomIdRef.current,
            username: name,
            hostToken,
          });
        } else {
          socket.emit("join_room", {
            roomId: roomIdRef.current,
            username: name,
          });
        }
      }
    };

    const handleRoomNotFound = (data: { roomId: string }) => {
      if (data.roomId !== roomIdRef.current) return;

      roomIdRef.current = "";
      setRoomId("");
      setParticipants([]);
      roomHostTokenRef.current = null;
      alert("Room not found");
    };

    const handleRoomCreationFailed = (data: {
      roomId: string;
      message: string;
    }) => {
      if (data.roomId !== roomIdRef.current) return;

      roomIdRef.current = "";
      setRoomId("");
      setParticipants([]);
      roomHostTokenRef.current = null;
      alert(data.message);
    };

    socket.on(
      "user_joined",
      handleUserJoined
    );

    socket.on(
      "user_left",
      handleUserLeft
    );

    socket.on(
      "role_assigned",
      handleRoleAssigned
    );

    socket.on("control_requests", handleControlRequests);
    socket.on("control_request_status", handleControlRequestStatus);

    socket.on(
      "sync_state",
      handleSyncState
    );

    socket.on(
      "participant_removed",
      handleParticipantRemoved
    );

    socket.on(
      "room_not_found",
      handleRoomNotFound
    );

    socket.on("room_creation_failed", handleRoomCreationFailed);

    socket.on(
      "connect",
      handleReconnect
    );

    return () => {
      socket.off(
        "user_joined",
        handleUserJoined
      );

      socket.off(
        "user_left",
        handleUserLeft
      );

      socket.off(
        "role_assigned",
        handleRoleAssigned
      );

      socket.off("control_requests", handleControlRequests);
      socket.off("control_request_status", handleControlRequestStatus);

      socket.off(
        "sync_state",
        handleSyncState
      );

      socket.off(
        "participant_removed",
        handleParticipantRemoved
      );

      socket.off(
        "room_not_found",
        handleRoomNotFound
      );

      socket.off("room_creation_failed", handleRoomCreationFailed);

      socket.off(
        "connect",
        handleReconnect
      );
    };
  }, [username, joinUsername]);

  // ---------------- PLAY ----------------

  const handlePlay = () => {
    if (remoteStateLockRef.current !== null) {
      return;
    }

    if (!canControlRef.current) {
      return;
    }

    if (
      !roomIdRef.current ||
      !playerRef.current
    ) {
      return;
    }

    const currentTime =
      playerRef.current.getCurrentTime();

    lastTimeRef.current = currentTime;

    console.log(
      "PLAY:",
      currentRole,
      currentTime
    );

    socket.emit("play", {
      roomId: roomIdRef.current,
      currentTime,
    });
  };

  // ---------------- PAUSE ----------------

  const handlePause = () => {
    if (remoteStateLockRef.current !== null) {
      return;
    }

    if (!canControlRef.current) {
      return;
    }

    if (
      !roomIdRef.current ||
      !playerRef.current
    ) {
      return;
    }

    const currentTime =
      playerRef.current.getCurrentTime();

    lastTimeRef.current = currentTime;

    console.log(
      "PAUSE:",
      currentRole,
      currentTime
    );

    socket.emit("pause", {
      roomId: roomIdRef.current,
      currentTime,
    });
  };

  // ---------------- YOUTUBE STATE ----------------

  const handleStateChange = (event: {
    data: number;
  }) => {
    const newState = event.data;

    if (newState === 1) setIsPlaying(true);
    if (newState === 2) setIsPlaying(false);

    playerStateRef.current = newState;

    console.log(
      "YOUTUBE STATE:",
      newState,
      "REMOTE LOCK:",
      remoteStateLockRef.current
    );

    // Buffering
    if (newState === 3) {
      return;
    }

    // Remote Play/Pause event
    if (remoteStateLockRef.current !== null) {
      return;
    }

    // Playing
    if (newState === 1) {
      handlePlay();
      return;
    }

    // Paused
    if (newState === 2) {
      handlePause();
      return;
    }
  };

  // ---------------- SEEK DETECTION ----------------

  const startSeekDetection = () => {
    if (
      seekTimerRef.current !== null
    ) {
      return;
    }

    seekTimerRef.current =
      window.setInterval(() => {
        if (
          !roomIdRef.current ||
          !playerRef.current
        ) {
          return;
        }

        if (!canControlRef.current) {
          return;
        }

        // Remote seek ke baad local seek detect mat karo
        if (remoteSeekLockRef.current) {
          return;
        }

        const currentTime =
          playerRef.current.getCurrentTime();

        const difference =
          Math.abs(
            currentTime -
            lastTimeRef.current
          );

        // ---------------- PAUSED VIDEO ----------------

        if (
          playerStateRef.current === 2
        ) {
          if (difference > 0.1) {
            console.log(
              "PAUSED SEEK DETECTED:",
              currentTime
            );

            socket.emit("seek", {
              roomId:
                roomIdRef.current,
              time: currentTime,
            });

            lastTimeRef.current =
              currentTime;
          }

          return;
        }

        // ---------------- PLAYING VIDEO ----------------

        if (
          playerStateRef.current === 1
        ) {
          if (difference > 1) {
            console.log(
              "PLAYING SEEK DETECTED:",
              currentTime
            );

            socket.emit("seek", {
              roomId:
                roomIdRef.current,
              time: currentTime,
            });

            lastTimeRef.current =
              currentTime;

            return;
          }

          // Normal playback
          lastTimeRef.current =
            currentTime;
        }
      }, 100);
  };

  // ---------------- PLAYER READY ----------------

  const handlePlayerReady = (event: {
    target: YouTubePlayer;
  }) => {
    playerRef.current =
      event.target;

    lastTimeRef.current =
      event.target.getCurrentTime();
    setPlaybackTime(event.target.getCurrentTime());
    setVideoDuration(event.target.getDuration());

    if (playbackUiTimerRef.current !== null) {
      window.clearInterval(playbackUiTimerRef.current);
    }
    playbackUiTimerRef.current = window.setInterval(() => {
      if (playerRef.current) {
        setPlaybackTime(playerRef.current.getCurrentTime());
        setVideoDuration(playerRef.current.getDuration());
      }
    }, 500);

    if (
      pendingSyncRef.current
    ) {
      const pendingSync =
        pendingSyncRef.current;

      pendingSyncRef.current =
        null;

      window.setTimeout(() => {
        applySyncState(
          pendingSync
        );
      }, 100);
    }

    startSeekDetection();
  };

  // ---------------- CLEANUP ----------------

  useEffect(() => {
    return () => {
      if (
        seekTimerRef.current !== null
      ) {
        window.clearInterval(
          seekTimerRef.current
        );

        seekTimerRef.current = null;
      }

      if (playbackUiTimerRef.current !== null) {
        window.clearInterval(playbackUiTimerRef.current);
        playbackUiTimerRef.current = null;
      }
    };
  }, []);

  // ---------------- RENDER ----------------

  return (
    <div className="app-root">
      {/* TOP NAVIGATION BAR */}
      <header className="top-nav">
        <div className="brand-wrapper">
          <span className="brand-icon-box">
            <svg
              className="brand-play-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <polygon points="7,4 20,12 7,20" />
            </svg>
          </span>
          <span className="brand-name">Watch Party</span>
        </div>

        <div className="nav-actions">
          <div className="connection-status">
            <span
              className={`status-dot ${isConnected ? "" : "disconnected"}`}
              aria-hidden="true"
            />
            <span>{isConnected ? "Connected" : "Disconnected"}</span>
          </div>

          {roomId && currentRole && (
            <span
              className={`role-chip ${
                currentRole === "Host"
                  ? "host"
                  : currentRole === "Moderator"
                  ? "moderator"
                  : "participant"
              }`}
            >
              {isHost
                ? "You're the host"
                : currentRole === "Moderator"
                ? "You're a moderator"
                : "Participant"}
            </span>
          )}

          {roomId && (
            <button
              type="button"
              className="leave-btn"
              onClick={leaveRoom}
              title="Leave watch party"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Leave
            </button>
          )}
        </div>
      </header>

      {/* LOBBY VIEW (when !roomId) */}
      {!roomId ? (
        <main className="lobby-viewport">
          <div className="lobby-card">
            <div className="lobby-header">
              <h1 className="lobby-title">Watch YouTube together</h1>
              <p className="lobby-subtitle">
                Start a room, share the code, and everyone's player stays in sync.
              </p>
            </div>

            <div className="lobby-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "create"}
                className={`tab-btn ${activeTab === "create" ? "active" : ""}`}
                onClick={() => setActiveTab("create")}
              >
                Create a room
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "join"}
                className={`tab-btn ${activeTab === "join" ? "active" : ""}`}
                onClick={() => setActiveTab("join")}
              >
                Join a room
              </button>
            </div>

            {activeTab === "create" ? (
              <form
                className="lobby-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  createRoom();
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="create-username">
                    Your name
                  </label>
                  <input
                    id="create-username"
                    className="form-input"
                    type="text"
                    placeholder="Enter your name"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </div>
                <button type="submit" className="primary-btn">
                  Create room
                </button>
              </form>
            ) : (
              <form
                className="lobby-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  joinRoom();
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="join-room-id">
                    Room code
                  </label>
                  <input
                    id="join-room-id"
                    className="form-input code-input"
                    type="text"
                    placeholder="e.g. K7M2QX"
                    maxLength={6}
                    value={joinRoomId}
                    onChange={(e) =>
                      setJoinRoomId(e.target.value.toUpperCase())
                    }
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="join-username">
                    Your name
                  </label>
                  <input
                    id="join-username"
                    className="form-input"
                    type="text"
                    placeholder="Enter your name"
                    value={joinUsername}
                    onChange={(e) => setJoinUsername(e.target.value)}
                  />
                </div>
                <button type="submit" className="primary-btn">
                  Join room
                </button>
              </form>
            )}

            <div className="ticket-footer">
              <span className="ticket-notch-left" aria-hidden="true" />
              <span className="ticket-notch-right" aria-hidden="true" />
              The host and moderators control playback. Everyone else watches in sync.
            </div>
          </div>
        </main>
      ) : (
        /* ROOM VIEW (when roomId is set) */
        <main className="room-layout">
          <div className="room-grid">
            {/* LEFT COLUMN: PLAYER & VIDEO SWITCHER */}
            <section className="player-column" aria-label="Video Player Area">
              <div className="player-wrapper">
                <YouTube
                  key={videoId}
                  videoId={videoId}
                  onReady={handlePlayerReady}
                  onStateChange={handleStateChange}
                  opts={{
                    width: "100%",
                    height: "100%",
                    playerVars: {
                      autoplay: 0,
                      controls: 0,
                      disablekb: 1,
                      modestbranding: 1,
                      rel: 0,
                    },
                  }}
                  className="youtube-container"
                  iframeClassName="youtube-iframe"
                />
                {!canControl && (
                  <div
                    className="player-interaction-shield"
                    aria-label="Playback controls are limited to Hosts and Moderators"
                  />
                )}
              </div>

              {canControl && (
                <div className="playback-control-panel">
                  <button
                    type="button"
                    className="playback-toggle-btn"
                    onClick={togglePlayback}
                    aria-label={isPlaying ? "Pause video" : "Play video"}
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <span className="playback-time-label">
                    {formatTime(playbackTime)}
                  </span>
                  <input
                    className="playback-seek-input"
                    type="range"
                    min="0"
                    max={videoDuration || 0}
                    step="0.25"
                    value={Math.min(playbackTime, videoDuration || 0)}
                    onChange={(event) => seekPlayback(Number(event.target.value))}
                    onPointerUp={publishPlaybackSeek}
                    onKeyUp={publishPlaybackSeek}
                    aria-label="Seek video"
                    disabled={!videoDuration}
                  />
                  <span className="playback-time-label">
                    {formatTime(videoDuration)}
                  </span>
                </div>
              )}

              <div className="video-switch-card">
                <input
                  type="text"
                  className="video-switch-input"
                  placeholder={
                    canControl
                      ? "Paste a YouTube link to switch videos"
                      : currentRole === "Participant"
                      ? "Paste a YouTube link to request a video change"
                      : "Waiting for room access..."
                  }
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canControl) {
                      e.preventDefault();
                      changeVideo();
                    }
                  }}
                  disabled={!canControl && currentRole !== "Participant"}
                />
                <button
                  type="button"
                  className="video-switch-btn"
                  onClick={changeVideo}
                  disabled={
                    (!canControl && currentRole !== "Participant") ||
                    !videoUrl.trim() ||
                    isControlRequestPending
                  }
                >
                  {canControl ? "Change video" : "Request video"}
                </button>
              </div>

              {currentRole === "Participant" && (
                <div className="control-request-panel">
                  <div className="control-request-heading">Request playback control</div>
                  <div className="control-request-actions">
                    <button
                      type="button"
                      className="request-action-btn"
                      disabled={!isConnected || isControlRequestPending}
                      onClick={() =>
                        requestControl(
                          "play",
                          playerRef.current?.getCurrentTime() || 0
                        )
                      }
                    >
                      Request play
                    </button>
                    <button
                      type="button"
                      className="request-action-btn"
                      disabled={!isConnected || isControlRequestPending}
                      onClick={() =>
                        requestControl(
                          "pause",
                          playerRef.current?.getCurrentTime() || 0
                        )
                      }
                    >
                      Request pause
                    </button>
                    <label className="seek-request-field">
                      <span>Seek to (seconds)</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={requestedSeekTime}
                        onChange={(event) => setRequestedSeekTime(event.target.value)}
                        disabled={!isConnected || isControlRequestPending}
                      />
                    </label>
                    <button
                      type="button"
                      className="request-action-btn"
                      disabled={
                        !isConnected ||
                        isControlRequestPending ||
                        requestedSeekTime === "" ||
                        Number(requestedSeekTime) < 0
                      }
                      onClick={() => {
                        requestControl("seek", Number(requestedSeekTime));
                        setRequestedSeekTime("");
                      }}
                    >
                      Request seek
                    </button>
                  </div>
                  <div className="control-request-status" role="status" aria-live="polite">
                    {controlRequestMessage || "A Host or Moderator must approve your request."}
                  </div>
                </div>
              )}

              <div className="player-info-bar">
                <span className="permission-notice">
                  {canControl
                    ? isHost
                      ? "You're the Host • You have full control over playback and video selection"
                      : "You're a Moderator • You can control playback and switch videos"
                    : "Watching in sync • Playback is synchronized with the room"}
                </span>
              </div>
            </section>

            {/* RIGHT COLUMN: ROOM CODE & PARTICIPANTS */}
            <aside className="sidebar-column" aria-label="Room details and participants">
              {/* ROOM CODE CARD */}
              <div className="sidebar-card">
                <div className="card-label">Room code</div>
                <div className="code-tiles-container" title="Share this code with friends">
                  {roomId.split("").map((char, index) => (
                    <span key={index} className="code-tile">
                      {char}
                    </span>
                  ))}
                </div>
                <div className="copy-action-row">
                  <button
                    type="button"
                    className={`copy-btn ${copied ? "copied" : ""}`}
                    onClick={copyRoomCode}
                  >
                    {copied ? (
                      <>
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Copied!
                      </>
                    ) : (
                      <>
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* PARTICIPANTS CARD */}
              <div className="sidebar-card">
                <div className="card-header-row">
                  <h2 className="card-title">In the room</h2>
                  <span className="count-pill">
                    {participants.length}
                  </span>
                </div>

                <div className="participants-list">
                  {participants.length === 0 ? (
                    <div className="participant-item">
                      <div className="participant-name">
                        {isConnected ? "Joining room..." : "Connecting to server..."}
                      </div>
                    </div>
                  ) : (
                    participants.map((user) => {
                      const isCurrentUser = user.userId === socket.id;
                      const avatarColors = getAvatarColor(user.username, user.role);

                      return (
                        <div key={user.userId} className="participant-item">
                          <div className="participant-header">
                            <span
                              className="avatar-circle"
                              style={{
                                backgroundColor: avatarColors.bg,
                                color: avatarColors.text,
                                border: `1px solid ${avatarColors.border}`,
                              }}
                            >
                              {(user.username || "U")[0].toUpperCase()}
                            </span>
                            <div className="participant-meta">
                              <div className="participant-name">
                                {user.username}
                                {isCurrentUser && (
                                  <span className="you-tag">you</span>
                                )}
                              </div>
                              <span
                                className={`role-chip ${
                                  user.role === "Host"
                                    ? "host"
                                    : user.role === "Moderator"
                                    ? "moderator"
                                    : "participant"
                                }`}
                              >
                                {user.role}
                              </span>
                            </div>
                          </div>

                          {/* HOST CONTROLS FOR OTHER PARTICIPANTS */}
                          {isHost && !isCurrentUser && (
                            <div className="host-controls-row">
                              <div className="role-segmented-toggle">
                                <button
                                  type="button"
                                  className={`segment-btn ${
                                    user.role === "Participant" ? "active" : ""
                                  }`}
                                  onClick={() =>
                                    assignRole(user.userId, "Participant")
                                  }
                                >
                                  Participant
                                </button>
                                <button
                                  type="button"
                                  className={`segment-btn ${
                                    user.role === "Moderator" ? "active" : ""
                                  }`}
                                  onClick={() =>
                                    assignRole(user.userId, "Moderator")
                                  }
                                >
                                  Moderator
                                </button>
                              </div>

                              {confirmRemoveUserId === user.userId ? (
                                <div className="confirm-group">
                                  <button
                                    type="button"
                                    className="confirm-action-btn"
                                    onClick={() => {
                                      removeParticipant(user.userId);
                                      setConfirmRemoveUserId(null);
                                    }}
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    type="button"
                                    className="cancel-action-btn"
                                    onClick={() =>
                                      setConfirmRemoveUserId(null)
                                    }
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="remove-trigger-btn"
                                  onClick={() =>
                                    setConfirmRemoveUserId(user.userId)
                                  }
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {canControl && controlRequests.length > 0 && (
                <div className="sidebar-card control-requests-card">
                  <div className="card-header-row">
                    <h2 className="card-title">Control requests</h2>
                    <span className="count-pill">{controlRequests.length}</span>
                  </div>
                  <div className="control-requests-list">
                    {controlRequests.map((request) => (
                      <div className="control-request-item" key={request.requestId}>
                        <div className="control-request-description">
                          <strong>{request.username}</strong> requested{" "}
                          {request.action === "change_video"
                            ? "a video change"
                            : request.action === "seek"
                            ? `a seek to ${request.value} seconds`
                            : `to ${request.action}`}
                        </div>
                        <div className="control-request-review-actions">
                          <button
                            type="button"
                            className="request-approve-btn"
                            onClick={() => reviewControlRequest(request.requestId, true)}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="request-reject-btn"
                            onClick={() => reviewControlRequest(request.requestId, false)}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </div>
        </main>
      )}
    </div>
  );
}

export default App;