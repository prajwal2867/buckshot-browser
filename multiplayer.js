(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const panel = byId("multiplayer-panel");
  const usernameKey = "buckshot-browser.username";
  const usernamePattern = /^[A-Za-z0-9_-]{3,16}$/;
  let socket = null;
  let activeRoomCode = null;
  let pendingRequest = null;

  const elements = {
    open: byId("multiplayer-open"),
    close: byId("multiplayer-close"),
    identity: byId("multiplayer-identity"),
    username: byId("multiplayer-username"),
    saveUsername: byId("username-save"),
    changeUsername: byId("username-change"),
    lobby: byId("multiplayer-lobby"),
    playerName: byId("multiplayer-player-name"),
    create: byId("room-create"),
    joinForm: byId("room-join-form"),
    joinCode: byId("room-code"),
    room: byId("multiplayer-room"),
    status: byId("multiplayer-status"),
    message: byId("multiplayer-message"),
    codeCard: byId("room-code-card"),
    codeDisplay: byId("room-code-display"),
    request: byId("join-request"),
    requestName: byId("join-request-name"),
    accept: byId("join-accept"),
    decline: byId("join-decline"),
    players: byId("room-players"),
    leave: byId("room-leave")
  };

  const getUsername = () => {
    try { return localStorage.getItem(usernameKey) || ""; }
    catch { return ""; }
  };

  const setMessage = (message) => { elements.message.textContent = message || ""; };

  function showIdentity() {
    const username = getUsername();
    elements.identity.hidden = Boolean(username);
    elements.lobby.hidden = !username;
    elements.room.hidden = true;
    elements.playerName.textContent = username;
    if (!username) elements.username.focus();
  }

  function emitWhenConnected(eventName, payload) {
    const connection = ensureSocket();
    if (!connection) return false;
    if (connection.connected) connection.emit(eventName, payload);
    else {
      setMessage("Connecting to multiplayer server...");
      connection.once("connect", () => connection.emit(eventName, payload));
    }
    return true;
  }

  function ensureSocket() {
    if (socket) return socket;
    if (typeof window.io !== "function") {
      setMessage("Multiplayer needs the online server. Start the app with npm start; opening index.html directly only supports single-player.");
      return null;
    }
    socket = window.io({ path: "/api/socket", addTrailingSlash: false, transports: ["websocket"] });
    socket.on("connect", () => setMessage("Connected to multiplayer server."));
    socket.on("disconnect", () => setMessage("Connection lost. Room state may be unavailable until the server connection returns."));
    socket.on("connect_error", () => setMessage("Could not connect to the multiplayer server."));
    socket.on("room:error", (data) => setMessage(data?.message || "Something went wrong."));
    socket.on("room:created", (data) => {
      activeRoomCode = data.code;
      elements.room.hidden = false;
      elements.lobby.hidden = true;
      elements.status.textContent = "Waiting for an opponent to request access.";
      elements.codeCard.hidden = false;
      elements.codeDisplay.textContent = data.code;
      elements.request.hidden = true;
      elements.players.hidden = true;
      setMessage("Room created. Share the four-digit code.");
    });
    socket.on("room:join-pending", (data) => {
      elements.room.hidden = false;
      elements.lobby.hidden = true;
      activeRoomCode = data.code;
      elements.status.textContent = "Join request sent. Waiting for the host to respond.";
      elements.codeCard.hidden = true;
      setMessage("Request sent to " + data.hostUsername + ".");
    });
    socket.on("room:join-request", (data) => {
      pendingRequest = data;
      elements.request.hidden = false;
      elements.requestName.textContent = data.username;
      setMessage("A player wants to join your room.");
    });
    socket.on("room:declined", () => {
      activeRoomCode = null;
      elements.room.hidden = true;
      elements.lobby.hidden = false;
      setMessage("The host declined your request.");
    });
    socket.on("room:joined", (data) => {
      activeRoomCode = data.code;
      elements.room.hidden = false;
      elements.lobby.hidden = true;
      elements.codeCard.hidden = false;
      elements.codeDisplay.textContent = data.code;
      elements.request.hidden = true;
      elements.players.hidden = false;
      elements.players.textContent = data.host.username + "  vs  " + data.guest.username;
      elements.status.textContent = "Connected to the room. Multiplayer gameplay is coming in the next phase.";
      setMessage("You joined the room successfully.");
    });
    socket.on("room:player-joined", (data) => {
      elements.request.hidden = true;
      pendingRequest = null;
      elements.players.hidden = false;
      elements.players.textContent = data.host.username + "  vs  " + data.guest.username;
      elements.status.textContent = "Opponent connected. The lobby is ready.";
      setMessage("Player joined. Match gameplay will be added in the next phase.");
    });
    return socket;
  }

  elements.open.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) showIdentity();
  });
  elements.close.addEventListener("click", () => { panel.hidden = true; });

  elements.saveUsername.addEventListener("click", () => {
    const username = elements.username.value.trim();
    if (!usernamePattern.test(username)) {
      setMessage("Use 3–16 letters, numbers, underscores or hyphens.");
      elements.username.focus();
      return;
    }
    try { localStorage.setItem(usernameKey, username); }
    catch {
      setMessage("Your browser blocked local storage. Allow site storage to save your username.");
      return;
    }
    setMessage("Username saved on this browser.");
    showIdentity();
  });

  elements.username.addEventListener("keydown", (event) => {
    if (event.key === "Enter") elements.saveUsername.click();
  });

  elements.changeUsername.addEventListener("click", () => {
    elements.username.value = getUsername();
    try { localStorage.removeItem(usernameKey); } catch {}
    showIdentity();
  });

  elements.create.addEventListener("click", () => {
    emitWhenConnected("room:create", { username: getUsername() });
  });

  elements.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = elements.joinCode.value.trim();
    if (!/^\d{4}$/.test(code)) {
      setMessage("Enter a valid four-digit room code.");
      return;
    }
    emitWhenConnected("room:join", { code, username: getUsername() });
  });

  elements.accept.addEventListener("click", () => {
    if (!socket || !pendingRequest) return;
    socket.emit("room:respond", {
      code: pendingRequest.code,
      requestId: pendingRequest.requestId,
      accepted: true
    });
  });

  elements.decline.addEventListener("click", () => {
    if (!socket || !pendingRequest) return;
    socket.emit("room:respond", {
      code: pendingRequest.code,
      requestId: pendingRequest.requestId,
      accepted: false
    });
    pendingRequest = null;
    elements.request.hidden = true;
    setMessage("Join request declined.");
  });

  elements.leave.addEventListener("click", () => {
    if (socket) socket.disconnect();
    socket = null;
    activeRoomCode = null;
    pendingRequest = null;
    elements.room.hidden = true;
    elements.request.hidden = true;
    showIdentity();
    setMessage("You left the multiplayer lobby.");
  });

  showIdentity();
})();
