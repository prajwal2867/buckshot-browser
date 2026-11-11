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
  let actionPending = false;
  let roomRequestPending = false;
  let wasDisconnected = false;
  let intentionalDisconnect = false;

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
    copyCode: byId("room-copy-code"), copyInvite: byId("room-copy-invite"),
    reconnect: byId("multiplayer-reconnect"), expiry: byId("room-expiry"),
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
    socket.on("connect", () => {
      el.reconnect.hidden = true;
      if (wasDisconnected) {
        wasDisconnected = false;
        setMessage("Reconnected. Your previous room could not be restored; create a new room or join again.");
      } else setMessage("Connected to multiplayer server.");
    });
    socket.on("disconnect", () => {
      if (intentionalDisconnect) return;
      wasDisconnected = true;
      actionPending = false;
      roomRequestPending = false;
      activeRoomCode = null;
      pendingRequest = null;
      isHost = false;
      latestGame = null;
      el.room.hidden = true;
      el.game.hidden = true;
      el.start.hidden = true;
      el.reconnect.hidden = false;
      showIdentity();
      setMessage("Connection lost. Your room has ended. Reconnect, then create a new room or join with a fresh code.");
    });
    socket.on("connect_error", () => {
      el.reconnect.hidden = false;
      setMessage("Could not reach the multiplayer server. Check your connection and try Reconnect.");
    });
    socket.on("room:error", (data) => {
      roomRequestPending = false;
      actionPending = false;
      el.create.disabled = false;
      el.joinOpen.disabled = false;
      el.start.disabled = false;
      el.accept.disabled = false;
      el.decline.disabled = false;
      const message = data?.message || "Something went wrong. Check the room code and try again.";
      if (/room is no longer ready|room.*expired/i.test(message)) {
        activeRoomCode = null;
        pendingRequest = null;
        isHost = false;
        latestGame = null;
        el.room.hidden = true;
        el.game.hidden = true;
        showIdentity();
        setMessage("This room has expired or a player disconnected. Create a new room or join with a fresh code.");
        return;
      }
      setMessage(message);
    });
    socket.on("game:error", (data) => {
      actionPending = false;
      const message = data?.message || "That move was rejected.";
      if (/match not found|room expired|room no longer exists/i.test(message)) {
        activeRoomCode = null;
        latestGame = null;
        el.game.hidden = true;
        el.room.hidden = true;
        showIdentity();
        setMessage("This room is no longer available. Create a new room or join with a fresh code.");
        return;
      }
      if (latestGame) renderGame(latestGame);
      setMessage(message + " Your turn has not been consumed; review the state and try again.");
    });

    socket.on("room:created", (data) => {
      activeRoomCode = data.code;
      roomRequestPending = false;
      el.create.disabled = false;
      isHost = true;
      el.room.hidden = false;
      el.lobby.hidden = true;
      el.status.textContent = "Room ready. Share the code and wait for your opponent.";
      el.expiry.textContent = "Rooms close after 5 minutes without activity. Start the match soon.";
      el.codeCard.hidden = false;
      el.codeDisplay.textContent = data.code.split("").join(" ");
      el.request.hidden = true;
      el.players.hidden = true;
      el.start.hidden = true;
      el.game.hidden = true;
      el.leave.textContent = "> LEAVE ROOM [ 1 ]";
      setMessage("");
    });
    socket.on("room:join-pending", (data) => {
      activeRoomCode = data.code;
      roomRequestPending = false;
      el.joinOpen.disabled = false;
      isHost = false;
      el.room.hidden = false;
      el.lobby.hidden = true;
      el.status.textContent = "Request sent. Waiting for the host to approve you.";
      el.expiry.textContent = "If the host does not respond, you can leave and try another room.";
      el.codeCard.hidden = true;
      el.leave.textContent = "> LEAVE ROOM [ 1 ]";
      setMessage("Request sent to " + data.hostUsername + ".");
    });
    socket.on("room:join-request", (data) => {
      pendingRequest = data;
      el.request.hidden = false;
      el.requestName.textContent = data.username;
      el.codeCard.hidden = false;
      el.leave.textContent = "> LEAVE ROOM [ 3 ]";
      setMessage("");
    });
    socket.on("room:declined", () => {
      activeRoomCode = null;
      roomRequestPending = false;
      el.room.hidden = true;
      el.lobby.hidden = false;
      el.joinForm.hidden = true;
      el.joinOpen.hidden = false;
      setMessage("The host declined your request.");
    });
    socket.on("room:player-joined", (data) => {
      pendingRequest = null;
      el.request.hidden = true;
      el.codeCard.hidden = true;
      el.players.hidden = false;
      el.players.textContent = "> " + data.host.username + " vs " + data.guest.username;
      el.status.textContent = "Opponent connected. The host can start when both players are ready.";
      el.start.hidden = false;
      el.start.textContent = "Start [ 1 ]";
      el.leave.textContent = "Leave [ 2 ]";
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
      el.players.textContent = "> " + data.host.username + " vs " + data.guest.username;
      el.status.textContent = "You are in. Waiting for the host to start the match.";
      el.start.hidden = true;
      el.leave.textContent = "> LEAVE ROOM [ 1 ]";
      setMessage("");
    });
    socket.on("game:started", () => {
      el.start.hidden = true;
      el.status.textContent = "MATCH IN PROGRESS";
      setMessage("The match has started.");
    });
    socket.on("game:state", (state) => {
      actionPending = false;
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
    const canAct = state.status === "playing" && state.yourTurn && !actionPending;
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
    if (actionPending) return;
    if (!socket || !socket.connected || !activeRoomCode) {
      setMessage("You are not connected to an active room. Reconnect and rejoin before making a move.");
      return;
    }
    actionPending = true;
    el.status.textContent = "Move sent. Waiting for the server to confirm…";
    el.turn.textContent = "Submitting your move…";
    el.shootOpponent.disabled = true;
    el.shootSelf.disabled = true;
    el.inventory.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    el.steal.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    socket.emit("game:action", { code: activeRoomCode, action });
  }

  async function copyText(value, successMessage) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access unavailable");
      await navigator.clipboard.writeText(value);
      setMessage(successMessage);
    } catch {
      setMessage("Clipboard access was blocked. Select the room code and copy it manually.");
    }
  }

  function showMode(mode) {
    const multiplayer = mode === "multiplayer";
    panel.hidden = !multiplayer;
    storyMode.hidden = multiplayer;
    el.open.classList.toggle("active", multiplayer);
    el.storyOpen.classList.toggle("active", !multiplayer);
    el.open.setAttribute("aria-pressed", String(multiplayer));
    el.storyOpen.setAttribute("aria-pressed", String(!multiplayer));
    if (multiplayer) {
      if (activeRoomCode) {
        el.identity.hidden = true;
        el.lobby.hidden = true;
        el.room.hidden = false;
      } else {
        showIdentity();
      }
    }
  }

  window.addEventListener("buckshot:mode", (event) => {
    if (event.detail === "multiplayer") showMode("multiplayer");
  });

  el.copyCode.addEventListener("click", () => {
    if (activeRoomCode) copyText(activeRoomCode, "Room code copied. Send it to your opponent.");
  });
  el.copyInvite.addEventListener("click", () => {
    if (!activeRoomCode) return;
    const invite = "Join my Buckshot Roulette match. Open " + window.location.href.split("?")[0] +
      ", choose Multiplayer, and enter room code " + activeRoomCode + ".";
    copyText(invite, "Invite message copied. Send it to your opponent.");
  });
  el.reconnect.addEventListener("click", () => {
    const connection = ensureSocket();
    if (!connection) return;
    setMessage("Reconnecting to multiplayer server…");
    el.reconnect.disabled = true;
    connection.connect();
    window.setTimeout(() => { el.reconnect.disabled = false; }, 1500);
  });

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
  el.create.addEventListener("click", () => {
    if (roomRequestPending) return;
    roomRequestPending = true;
    el.create.disabled = true;
    setMessage("Creating your room…");
    if (!emitWhenConnected("room:create", { username: getUsername() })) {
      roomRequestPending = false;
      el.create.disabled = false;
    }
  });
  el.joinOpen.addEventListener("click", () => {
    el.joinOpen.hidden = true;
    el.joinForm.hidden = false;
    el.joinCode.focus();
  });
  el.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = el.joinCode.value.trim();
    if (!/^\d{4}$/.test(code)) { setMessage("Enter a valid four-digit room code."); return; }
    roomRequestPending = true;
    el.joinOpen.disabled = true;
    setMessage("Sending your join request…");
    if (!emitWhenConnected("room:join", { code, username: getUsername() })) {
      roomRequestPending = false;
      el.joinOpen.disabled = false;
    }
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
    if (!isHost || !socket?.connected || !activeRoomCode || el.start.disabled) return;
    el.start.disabled = true;
    el.status.textContent = "Starting match…";
    socket.emit("game:start", { code: activeRoomCode });
  });
  el.shootOpponent.addEventListener("click", () => sendAction({ type: "shoot", target: "opponent" }));
  el.shootSelf.addEventListener("click", () => sendAction({ type: "shoot", target: "self" }));
  // Number shortcuts mirror the bracketed actions shown in the matchmaking UI.
  // Ignore keystrokes while the user is typing, and only handle shortcuts in Multiplayer.
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    if (panel.hidden || storyMode.hidden === false) return;
    if (el.game.hidden === false) return;

    const target = event.target;
    const isTyping = target instanceof HTMLElement && (
      target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
    );
    if (isTyping) return;

    const key = event.key;
    let action = null;

    if (el.room.hidden) {
      if (el.joinForm.hidden) {
        if (key === "1") action = el.create;
        if (key === "2") action = el.joinOpen;
      }
    } else if (!el.request.hidden) {
      if (key === "1") action = el.accept;
      if (key === "2") action = el.decline;
      if (key === "3") action = el.leave;
    } else if (!el.players.hidden) {
      if (isHost && key === "1") action = el.start;
      else if (isHost && key === "2") action = el.leave;
      else if (!isHost && key === "1") action = el.leave;
    } else if (key === "1") {
      action = el.leave;
    }

    if (action && !action.hidden && !action.disabled) {
      event.preventDefault();
      action.click();
    }
  });

  el.leave.addEventListener("click", () => {
    intentionalDisconnect = true;
    if (socket) socket.disconnect();
    socket = null;
    intentionalDisconnect = false;
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