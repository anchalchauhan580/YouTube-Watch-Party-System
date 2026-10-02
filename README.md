# YouTube Watch Party

A real-time watch room where a Host and approved Moderators control a shared YouTube video. Participants can watch, request playback changes, and see room membership and roles.

**Live app:** https://youtube-watch-party-system-production.up.railway.app

## Features

- Create a room and share its six-character code; the creator is the Host.
- Join an existing room as a Participant.
- Synchronize video changes, play/pause state, and seek position through Socket.IO.
- Let the Host promote Participants to Moderator, remove participants, and review control requests.
- Allow Participants to request play, pause, seek, and video changes. A Host or Moderator must approve a request before the server applies it.
- Enforce playback permissions on both the client and server.

## Run Locally

Requirements: Node.js 20 or later and npm.

Start the Socket.IO backend in one terminal:

```sh
cd backend
npm install
npm start
```

Start the Vite frontend in another terminal from the repository root:

```sh
npm install
npm run dev
```

The frontend defaults to `http://localhost:5000` for its Socket.IO server during development. The backend listens on port `5000` unless `PORT` is set.

## Deployment

The frontend is deployed at the live URL above. Configure the frontend build variable `VITE_SOCKET_URL` to the public URL of the Socket.IO backend. Configure the backend variable `CLIENT_ORIGIN` to the frontend's public origin, and let the platform provide `PORT`. Rebuild/redeploy the frontend after changing `VITE_SOCKET_URL`, since Vite embeds it during build.

For Railway, deploy the backend from the `backend` directory with `npm start`. Deploy the frontend from the repository root using `npm run build` and serve the generated `dist` directory. The backend's root health endpoint returns `Watch Party Server is running`.

## Architecture

The React client embeds YouTube with `react-youtube` and uses `socket.io-client` to communicate with the Express/Socket.IO server. The server stores each room's participants, roles, pending requests, and current playback state in memory. When a Host or Moderator changes playback, the server validates the sender's role, updates the room state, and broadcasts `sync_state` to the room. Joining participants receive the current state immediately.

Control requests follow the same authority boundary: the server accepts requests only from Participants, sends the pending queue to Hosts and Moderators, then validates the reviewer before applying an approved action. Role assignment and removal are Host-only. Participants' embedded player is shielded from direct pointer interaction; they use the request controls instead.

## Roles

| Role | Permissions |
| --- | --- |
| Host | Play, pause, seek, change video, assign Moderator/Participant roles, remove participants, approve or decline requests |
| Moderator | Play, pause, seek, change video, approve or decline requests |
| Participant | Watch and request playback or video changes |

## MVP Limitations

Rooms and playback state are in-memory and disappear when the backend restarts. The backend is intended to run as a single instance; multiple instances need shared room storage and a Socket.IO adapter such as the Redis adapter. Login, persistent storage, chat, and host transfer are not included.