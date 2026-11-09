(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const panel = byId("multiplayer-panel");
  const storyMode = byId("story-mode");
  const usernameKey = "buckshot-browser.username";
  const usernamePattern = /^[A-Za-z0-9_-]{3,16}$/;
  let socket = null;
  let activeRoomCode = null;
  let pendingRequest = null;
  let isHost = false;
  let latestGame = null;

  const el = {
    open: byId("multiplayer-open"), storyOpen: byId("story-open"),
    identity: byId("multiplayer-identity"), username: byId("multiplayer-username"),
    saveUsername: byId("username-save"), changeUsername: byId("username-change"),
    lobby: byId("multiplayer-lobby"), playerName: byId("multiplayer-player-name"),
    create: byId("room-create"), joinOpen: byId("room-join-open"),
    joinForm: byId("room-join-form"), joinCode: byId("room-code"),
    room: byId("multiplayer-room"), status: byId("multiplayer-status"),
    message: byId("multiplayer-message"), codeCard: byId("room-code-card"),
    codeDisplay: byId("room-code-display"), request: byId("join-request"),
    requestName: byId("join-request-name"), accept: byId("join-accept"),
    decline: byId("join-decline"), players: byId("room-players"),
    leave: byId("room-leave"), start: byId("game-start"), game: byId("pvp-game"),
    turn: byId("pvp-turn"), scoreboard: byId("pvp-scoreboard"),
    magazine: byId("pvp-magazine"), known: byId("pvp-known-shell"),
    shootOpponent: byId("pvp-shoot-opponent"), shootSelf: byId("pvp-shoot-self"),
    inventory: byId("pvp-inventory"), steal: byId("pvp-steal"), events: byId("pvp-events")
  };

  const getUsername = () => {
    try { return localStorage.getItem(usernameKey) || ""; } catch { return ""; }
  };
  const setMessage = (message) => { el.message.textContent = message || ""; };
  const makeButton = (label, onClick, className = "") => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", onClick);
    return button;
  };

  function showIdentity() {
    const username = getUsername();
    el.identity.hidden = Boolean(username);
    el.lobby.hidden = !username;
    el.room.hidden = true;
    el.joinForm.hidden = true;
    el.joinOpen.hidden = false;
    el.playerName.textContent = username;
    if (!username) el.username.focus();
  }

  function ensureSocket() {
    if (socket) return socket;
    if (typeof window.io !== "function") {
      setMessage("Multiplayer needs the online server. Run npm start; opening index.html directly only supports single-player.");
      return null;
    }
    socket = window.io({ path: "/api/socket", addTrailingSlash: false, transports: ["websocket"] });
    socket.on("connect", () => setMessage("Connected to multiplayer server."));
    socket.on("disconnect", () => setMessage("Connection lost. The current match may be interrupted."));
    socket.on("connect_error", () => setMessage("Could not connect to the multiplayer server."));
    socket.on("room:error", (data) => setMessage(data?.message || "Something went wrong."));
    socket.on("game:error", (data) => setMessage(data?.message || "That move was rejected."));

    socket.on("room:created", (data) => {
      activeRoomCode = data.code;
      isHost = true;
      el.room.hidden = false;
      el.lobby.hidden = true;
      el.status.textContent = "WAITING ...";
      el.codeCard.hidden = false;
      el.codeDisplay.textContent = data.code.split("").join(" ");
      el.request.hidden = true;
      el.players.hidden = true;
      el.start.hidden = true;
      el.game.hidden = true;
      el.leave.textContent = "LEAVE ROOM [ 1 ]";
      setMessage("");
    });
    socket.on("room:join-pending", (data) => {
      activeRoomCode = data.code;
      isHost = false;
      el.room.hidden = false;
      el.lobby.hidden = true;
      el.status.textContent = "WAITING ...";
      el.codeCard.hidden = true;
      el.leave.textContent = "LEAVE ROOM [ 1 ]";
      setMessage("Request sent to " + data.hostUsername + ".");
    });
    socket.on("room:join-request", (data) => {
      pendingRequest = data;
      el.request.hidden = false;
      el.requestName.textContent = data.username;
      el.codeCard.hidden = false;
      el.leave.textContent = "LEAVE ROOM [ 3 ]";
      setMessage("");
    });
    socket.on("room:declined", () => {
      activeRoomCode = null;
      el.room.hidden = true;
      el.lobby.hidden = false;
      setMessage("The host declined your request.");
    });
    socket.on("room:player-joined", (data) => {
      pendingRequest = null;
      el.request.hidden = true;
      el.codeCard.hidden = true;
      el.players.hidden = false;
      el.players.textContent = data.host.username + " VS " + data.guest.username;
      el.status.textContent = "";
      el.start.hidden = false;
      el.start.textContent = "START [ 1 ]";
      el.leave.textContent = "LEAVE [ 2 ]";
      setMessage("");
    });
    socket.on("room:joined", (data) => {
      activeRoomCode = data.code;
      isHost = false;
      el.room.hidden = false;
      el.lobby.hidden = true;
      el.codeCard.hidden = false;
      el.codeDisplay.textContent = data.code.split("").join(" ");
      el.request.hidden = true;
      el.players.hidden = false;
      el.players.textContent = data.host.username + " VS " + data.guest.username;
      el.status.textContent = "WAITING ...";
      el.start.hidden = true;
      el.leave.textContent = "LEAVE ROOM [ 1 ]";
      setMessage("");
    });
    socket.on("game:started", () => {
      el.start.hidden = true;
      el.status.textContent = "MATCH IN PROGRESS";
      setMessage("The match has started.");
    });
    socket.on("game:state", (state) => {
      latestGame = state;
      renderGame(state);
    });
    return socket;
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

  function renderGame(state) {
    el.game.hidden = false;
    el.start.hidden = true;
    el.status.textContent = state.status === "finished" ? "Match finished." : "Match in progress.";
    el.turn.textContent = state.status === "finished"
      ? (state.winner || "A player") + " wins."
      : state.yourTurn ? "Your turn." : state.turnUsername + "'s turn.";
    el.scoreboard.replaceChildren();
    state.players.forEach((player) => {
      const card = document.createElement("div");
      card.className = "pvp-player";
      const name = document.createElement("strong");
      name.textContent = player.username;
      const health = document.createElement("span");
      health.textContent = "Health: " + player.health + " / " + player.maxHealth;
      const inventory = document.createElement("small");
      inventory.textContent = "Items: " + (player.inventory.length ? player.inventory.join(", ") : "none");
      card.append(name, health, inventory);
      el.scoreboard.append(card);
    });
    el.magazine.textContent = "Magazine " + state.magazine.reload + " · " +
      state.magazine.remaining + " shells remaining (" + state.magazine.live + " live / " +
      state.magazine.blank + " blank)";
    el.known.textContent = state.knownCurrentShell
      ? "Your current-shell information: " + state.knownCurrentShell.toUpperCase()
      : "You do not know the current shell.";
    const canAct = state.status === "playing" && state.yourTurn;
    el.shootOpponent.disabled = !canAct || state.stealOptions.length > 0;
    el.shootSelf.disabled = !canAct || state.stealOptions.length > 0;
    el.inventory.replaceChildren();
    const own = state.players.find((player) => player.isYou);
    if (own) {
      own.inventory.forEach((item, index) => {
        const button = makeButton("Use " + item, () => sendAction({ type: "item", itemIndex: index }), "secondary-button");
        button.disabled = !canAct || state.stealOptions.length > 0;
        el.inventory.append(button);
      });
    }
    el.steal.hidden = !state.stealOptions.length;
    el.steal.replaceChildren();
    if (state.stealOptions.length) {
      const heading = document.createElement("p");
      heading.textContent = "Choose an item to steal:";
      el.steal.append(heading);
      state.stealOptions.forEach((item, index) => {
        el.steal.append(makeButton(item, () => sendAction({ type: "steal", itemIndex: index })));
      });
    }
    el.events.replaceChildren();
    state.events.slice(-12).forEach((message) => {
      const line = document.createElement("p");
      line.textContent = "› " + message;
      el.events.append(line);
    });
  }

  function sendAction(action) {
    if (!socket || !activeRoomCode) return;
    socket.emit("game:action", { code: activeRoomCode, action });
  }

  function showMode(mode) {
    const multiplayer = mode === "multiplayer";
    panel.hidden = !multiplayer;
    storyMode.hidden = multiplayer;
    el.open.classList.toggle("active", multiplayer);
    el.storyOpen.classList.toggle("active", !multiplayer);
    el.open.setAttribute("aria-pressed", String(multiplayer));
    el.storyOpen.setAttribute("aria-pressed", String(!multiplayer));
    if (multiplayer) showIdentity();
  }

  el.open.addEventListener("click", () => showMode("multiplayer"));
  el.storyOpen.addEventListener("click", () => showMode("story"));
  el.saveUsername.addEventListener("click", () => {
    const username = el.username.value.trim();
    if (!usernamePattern.test(username)) {
      setMessage("Use 3–16 letters, numbers, underscores or hyphens.");
      el.username.focus();
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
  el.username.addEventListener("keydown", (event) => {
    if (event.key === "Enter") el.saveUsername.click();
  });
  el.changeUsername.addEventListener("click", () => {
    el.username.value = getUsername();
    try { localStorage.removeItem(usernameKey); } catch {}
    showIdentity();
  });
  el.create.addEventListener("click", () => emitWhenConnected("room:create", { username: getUsername() }));
  el.joinOpen.addEventListener("click", () => {
    el.joinOpen.hidden = true;
    el.joinForm.hidden = false;
    el.joinCode.focus();
  });
  el.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = el.joinCode.value.trim();
    if (!/^\d{4}$/.test(code)) { setMessage("Enter a valid four-digit room code."); return; }
    emitWhenConnected("room:join", { code, username: getUsername() });
  });
  el.accept.addEventListener("click", () => {
    if (socket && pendingRequest) socket.emit("room:respond", {
      code: pendingRequest.code, requestId: pendingRequest.requestId, accepted: true
    });
  });
  el.decline.addEventListener("click", () => {
    if (!socket || !pendingRequest) return;
    socket.emit("room:respond", {
      code: pendingRequest.code, requestId: pendingRequest.requestId, accepted: false
    });
    pendingRequest = null;
    el.request.hidden = true;
    el.leave.textContent = "LEAVE ROOM [ 1 ]";
    setMessage("Join request declined.");
  });
  el.start.addEventListener("click", () => {
    if (isHost && socket && activeRoomCode) socket.emit("game:start", { code: activeRoomCode });
  });
  el.shootOpponent.addEventListener("click", () => sendAction({ type: "shoot", target: "opponent" }));
  el.shootSelf.addEventListener("click", () => sendAction({ type: "shoot", target: "self" }));
  el.leave.addEventListener("click", () => {
    if (socket) socket.disconnect();
    socket = null;
    activeRoomCode = null;
    pendingRequest = null;
    isHost = false;
    latestGame = null;
    el.game.hidden = true;
    el.start.hidden = true;
    el.room.hidden = true;
    el.request.hidden = true;
    showIdentity();
    setMessage("You left the multiplayer lobby.");
  });

  showIdentity();
})();