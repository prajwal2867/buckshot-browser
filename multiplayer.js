(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const panel = byId("multiplayer-panel");
  const storyMode = byId("story-mode");
  const usernameKey = "buckshot-browser.username";
  const walletTokenKey = "buckshot-browser.multiplayer-token";
  const usernamePattern = /^[A-Za-z0-9_-]{3,16}$/;
  const ITEM_ORDER = ["Magnifying Glass", "Handcuffs", "Beer", "Cigarette Pack", "Hand Saw", "Inverter", "Burner Phone", "Expired Medicine", "Adrenaline"];
  let itemMenuOpen = false;
  let pendingMenuSelection = null;
  let socket = null;
  let activeRoomCode = null;
  let pendingRequest = null;
  let isHost = false;
  let latestGame = null;
  let actionPending = false;
  let roomRequestPending = false;
  let wasDisconnected = false;
  let intentionalDisconnect = false;
  let roomExpiryAt = 0;
  let roomExpiryTimer = null;
  let identityReady = false;
  let walletState = null;
  let currentWager = null;
  const pendingIdentityEmits = [];

  const el = {
    identity: byId("multiplayer-identity"), username: byId("multiplayer-username"),
    saveUsername: byId("username-save"), changeUsername: byId("username-change"),
    lobby: byId("multiplayer-lobby"), playerName: byId("multiplayer-player-name"),
    create: byId("room-create"), joinOpen: byId("room-join-open"),
    joinForm: byId("room-join-form"), joinCode: byId("room-code"),
    room: byId("multiplayer-room"), status: byId("multiplayer-status"), wallet: byId("multiplayer-wallet"),
    wagerPanel: byId("wager-panel"), wagerForm: byId("wager-proposal-form"), wagerStake: byId("wager-stake"),
    wagerPending: byId("wager-pending"), wagerDescription: byId("wager-description"),
    wagerAccept: byId("wager-accept"), wagerDecline: byId("wager-decline"), wagerConfirmed: byId("wager-confirmed"),
    message: byId("multiplayer-message"), codeCard: byId("room-code-card"),
    codeDisplay: byId("room-code-display"), request: byId("join-request"),
    requestName: byId("join-request-name"), accept: byId("join-accept"),
    decline: byId("join-decline"), players: byId("room-players"),
    leave: byId("room-leave"), start: byId("game-start"), game: byId("pvp-game"),
    reconnect: byId("multiplayer-reconnect"), expiry: byId("room-expiry"),
    balance: byId("pvp-balance"), wager: byId("pvp-wager"), versus: byId("pvp-versus"), stage: byId("pvp-stage"), turn: byId("pvp-turn"), scoreboard: byId("pvp-scoreboard"),
    magazine: byId("pvp-magazine"), known: byId("pvp-known-shell"),
    shootOpponent: byId("pvp-shoot-opponent"), shootSelf: byId("pvp-shoot-self"),
    inventory: byId("pvp-inventory"), steal: byId("pvp-steal"), events: byId("pvp-events"),
    commandForm: byId("pvp-command-form"), commandPrompt: byId("pvp-command-prompt"),
    commandInput: byId("pvp-command-input"), keypad: byId("pvp-keypad")
  };

  const getWalletToken = () => { try { return localStorage.getItem(walletTokenKey) || ""; } catch { return ""; } };
  const setWalletState = (state) => {
    walletState = state;
    if (state) el.wallet.textContent = "MULTIPLAYER BALANCE: $" + state.balance + (state.locked ? " | LOCKED: $" + state.locked : "");
    if (latestGame && !el.game.hidden) renderGame(latestGame);
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

  function clearRoomExpiryCountdown() {
    if (roomExpiryTimer) window.clearInterval(roomExpiryTimer);
    roomExpiryTimer = null;
    roomExpiryAt = 0;
    el.expiry.textContent = "";
  }

  function startRoomExpiryCountdown() {
    clearRoomExpiryCountdown();
    roomExpiryAt = Date.now() + 5 * 60 * 1000;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((roomExpiryAt - Date.now()) / 1000));
      const minutes = Math.floor(remaining / 60);
      const seconds = String(remaining % 60).padStart(2, "0");
      el.expiry.textContent = remaining
        ? "Room expires in " + minutes + ":" + seconds + " without activity."
        : "Room expired. Return to the lobby to create or join another room.";
      if (!remaining) {
        clearRoomExpiryCountdown();
        activeRoomCode = null;
        pendingRequest = null;
        isHost = false;
        latestGame = null;
        el.room.hidden = true;
        el.game.hidden = true;
        showIdentity();
        setMessage("This room has expired after 5 minutes without activity. Create a new room or join with a fresh code.");
      }
    };
    update();
    roomExpiryTimer = window.setInterval(update, 1000);
  }

  function showIdentity() {
    clearRoomExpiryCountdown();
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
      identityReady = false;
      socket.emit("identity:register", { username: getUsername(), token: getWalletToken() });
      if (wasDisconnected) {
        wasDisconnected = false;
        setMessage("Reconnected. Your wallet is being restored; create a new room or join again.");
      } else setMessage("Connected. Loading your multiplayer wallet...");
    });
    socket.on("identity:ready", (data) => {
      identityReady = true;
      try { localStorage.setItem(walletTokenKey, data.token); } catch {}
      setWalletState({ balance: data.balance, locked: data.locked, username: data.username });
      while (pendingIdentityEmits.length) {
        const pending = pendingIdentityEmits.shift();
        socket.emit(pending.eventName, pending.payload);
      }
      setMessage("Multiplayer wallet ready.");
    });
    socket.on("identity:error", (data) => {
      identityReady = false;
      setMessage(data?.message || "Could not load your multiplayer wallet.");
    });
    socket.on("wallet:state", setWalletState);
    socket.on("wager:state", (wager) => {
      currentWager = wager;
      renderWager();
    });
    socket.on("wager:error", (data) => {
      setMessage(data?.message || "Could not process that wager.");
    });
    socket.on("disconnect", () => {
      if (intentionalDisconnect) return;
      wasDisconnected = true;
      identityReady = false;
      clearRoomExpiryCountdown();
      actionPending = false;
      roomRequestPending = false;
      activeRoomCode = null;
      pendingRequest = null;
      isHost = false;
      latestGame = null;
      itemMenuOpen = false;
      pendingMenuSelection = null;
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
      startRoomExpiryCountdown();
      isHost = true;
      el.room.hidden = false;
      el.lobby.hidden = true;
      currentWager = null;
      el.wagerPanel.hidden = true;
      el.status.textContent = "Room ready. Share the code and wait for your opponent.";
      el.expiry.textContent = "Rooms close after 5 minutes without activity. Start the match soon.";
      el.codeCard.hidden = false;
      el.codeDisplay.textContent = data.code;
      startRoomExpiryCountdown();
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
      startRoomExpiryCountdown();
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
      startRoomExpiryCountdown();
      pendingRequest = data;
      el.request.hidden = false;
      el.requestName.textContent = data.username;
      el.codeCard.hidden = false;
      el.leave.textContent = "> LEAVE ROOM [ 3 ]";
      setMessage("");
    });
    socket.on("room:request-declined", (data) => {
      if (activeRoomCode !== data.code) return;
      pendingRequest = null;
      el.request.hidden = true;
      startRoomExpiryCountdown();
      setMessage("Join request declined. Your room is still available to share.");
    });
    socket.on("room:declined", () => {
      clearRoomExpiryCountdown();
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
      startRoomExpiryCountdown();
      el.request.hidden = true;
      el.codeCard.hidden = true;
      el.players.hidden = false;
      el.players.textContent = "> " + data.host.username + " vs " + data.guest.username;
      el.status.textContent = "Opponent connected. The host can start when both players are ready.";
      el.start.hidden = true;
      el.start.textContent = "Start [ 1 ]";
      el.wagerPanel.hidden = false;
      el.wagerForm.hidden = false;
      el.wagerPending.hidden = true;
      el.wagerConfirmed.hidden = true;
      currentWager = null;
      el.leave.textContent = "Leave [ 2 ]";
      setMessage("");
    });
    socket.on("room:joined", (data) => {
      activeRoomCode = data.code;
      isHost = false;
      el.room.hidden = false;
      el.lobby.hidden = true;
      el.codeCard.hidden = false;
      el.codeDisplay.textContent = data.code;
      el.request.hidden = true;
      el.players.hidden = false;
      el.players.textContent = "> " + data.host.username + " vs " + data.guest.username;
      el.status.textContent = "You are in. Waiting for the host to start the match.";
      el.start.hidden = true;
      el.wagerPanel.hidden = false;
      el.wagerForm.hidden = true;
      el.wagerPending.hidden = true;
      el.wagerConfirmed.hidden = true;
      currentWager = null;
      el.leave.textContent = "> LEAVE ROOM [ 1 ]";
      setMessage("");
    });
    socket.on("game:started", () => {
      el.start.hidden = true;
      el.wagerPanel.hidden = true;
      el.status.textContent = "MATCH IN PROGRESS";
      clearRoomExpiryCountdown();
      setMessage("");
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
    if (identityReady && connection.connected) connection.emit(eventName, payload);
    else {
      pendingIdentityEmits.push({ eventName, payload });
      setMessage("Loading your multiplayer wallet...");
    }
    return true;
  }

  function renderWager() {
    if (el.wagerPanel.hidden) return;
    const status = currentWager?.status || "none";
    el.wagerForm.hidden = !isHost || !["none", "declined", "rejected", "refunded"].includes(status);
    el.wagerPending.hidden = !(status === "proposed" && !isHost);
    el.wagerConfirmed.hidden = !["locked", "settled", "refunded"].includes(status);
    if (status === "proposed") {
      el.wagerDescription.textContent = "OPPONENT PROPOSES $" + currentWager.stake + " | YOUR POTENTIAL POT: $" + currentWager.pot;
      if (isHost) {
        el.wagerPending.hidden = false;
        el.wagerAccept.hidden = true;
        el.wagerDecline.hidden = true;
      } else {
        el.wagerAccept.hidden = false;
        el.wagerDecline.hidden = false;
      }
    }
    if (status === "locked") {
      el.wagerConfirmed.textContent = "BET LOCKED: $" + currentWager.stake + " EACH | POT: $" + currentWager.pot + " | HOST CAN START";
      el.start.textContent = "1. Start";
      el.start.hidden = !isHost;
    } else if (status === "settled") {
      el.wagerConfirmed.textContent = "BET SETTLED. WINNER PAID $" + currentWager.pot + ".";
      el.start.hidden = true;
    } else if (status === "refunded") {
      el.wagerConfirmed.textContent = "BET REFUNDED. BOTH PLAYERS' STAKES RETURNED.";
      el.start.hidden = true;
    } else if (status === "declined" || status === "rejected") {
      el.wagerConfirmed.textContent = status === "declined" ? "BET REJECTED. HOST MAY PROPOSE ANOTHER." : "BET COULD NOT BE LOCKED. TRY ANOTHER AMOUNT.";
      el.wagerConfirmed.hidden = false;
      el.start.hidden = true;
    } else if (status === "none") {
      el.start.hidden = true;
    }
  }

  function renderGame(state) {
    el.game.hidden = false;
    el.start.hidden = true;
    el.status.hidden = true;
    el.wallet.hidden = true;
    el.players.hidden = true;
    el.balance.textContent = "CURRENT BALANCE: $" + (walletState?.balance ?? "—");

    if (currentWager?.status === "settled") {
      el.wager.textContent = "BET SETTLED | POT PAID: $" + currentWager.pot;
    } else if (currentWager?.status === "refunded") {
      el.wager.textContent = "BET REFUNDED";
    } else if (currentWager?.status === "locked") {
      el.wager.textContent = "ACTIVE BET: $" + currentWager.stake +
        " | WIN: $" + currentWager.stake + " | LOCKED: $" + currentWager.stake;
    } else {
      el.wager.textContent = "NO ACTIVE BET";
    }

    el.versus.textContent = "> " + state.players.map((player) => player.username).join(" vs. ");
    el.stage.textContent = "=== stage 1 ===";
    el.magazine.textContent = "MAG COUNT: " + state.magazine.reload +
      "\nSHELLS: " + state.magazine.remaining + " ( " + state.magazine.live +
      " LIVE / " + state.magazine.blank + " BLANK )";
    el.known.hidden = !state.knownCurrentShell;
    el.known.textContent = state.knownCurrentShell
      ? "CURRENT SHELL: " + state.knownCurrentShell.toUpperCase()
      : "";

    el.scoreboard.replaceChildren();
    state.players.forEach((player) => {
      const lives = document.createElement("p");
      lives.className = "pvp-line";
      lives.textContent = player.username + " LIVES: " + player.health;
      el.scoreboard.append(lives);
    });
    state.players.forEach((player) => {
      const items = document.createElement("p");
      items.className = "pvp-line";
      items.textContent = player.username + " ITEMS [" + player.inventory.length + "]: " +
        (player.inventory.length ? player.inventory.join(", ") : "none");
      el.scoreboard.append(items);
    });

    const canAct = state.status === "playing" && state.yourTurn && !actionPending;
    el.shootOpponent.textContent = "1. Shoot opponent";
    el.shootSelf.textContent = "2. Shoot yourself";
    el.shootOpponent.disabled = !canAct || state.stealOptions.length > 0;
    el.shootSelf.disabled = !canAct || state.stealOptions.length > 0;

    const own = state.players.find((player) => player.isYou);
    if (!state.yourTurn || state.status !== "playing" || !own?.inventory.length || state.stealOptions.length) {
      itemMenuOpen = false;
      pendingMenuSelection = null;
    }
    if (pendingMenuSelection && own) {
      const remaining = own.inventory.filter((item) => item === pendingMenuSelection.item).length;
      if (remaining < pendingMenuSelection.count) {
        itemMenuOpen = false;
        pendingMenuSelection = null;
      }
    }
    el.inventory.replaceChildren();
    const useItem = makeButton("3. Use an item", () => {
      itemMenuOpen = Boolean(own?.inventory.length);
      sendAction({ type: "item:menu" });
      if (latestGame) renderGame(latestGame);
    });
    useItem.className = "pvp-use-item";
    useItem.disabled = !canAct || state.stealOptions.length > 0;
    el.inventory.append(useItem);
    if (itemMenuOpen && own?.inventory.length) {
      const heading = document.createElement("p");
      heading.className = "pvp-line";
      heading.textContent = "INVENTORY — CHOOSE AN ITEM";
      el.inventory.append(heading);
      ITEM_ORDER.filter((item) => own.inventory.includes(item)).forEach((item, index) => {
        const line = document.createElement("p");
        line.className = "pvp-line";
        line.textContent = (index + 1) + ". " + item;
        el.inventory.append(line);
      });
      const back = document.createElement("p");
      back.className = "pvp-line";
      back.textContent = "0. Return to your actions";
      el.inventory.append(back);
    }

    el.steal.hidden = !state.stealOptions.length;
    el.steal.replaceChildren();
    if (state.stealOptions.length) {
      const heading = document.createElement("p");
      heading.className = "pvp-line";
      heading.textContent = "ADRENALINE — CHOOSE AN ITEM TO STEAL";
      el.steal.append(heading);
      const instruction = document.createElement("p");
      instruction.className = "pvp-line";
      instruction.textContent = "Choose quickly; select an item number.";
      el.steal.append(instruction);
      state.stealOptions.forEach((item, index) => {
        const line = document.createElement("p");
        line.className = "pvp-line";
        line.textContent = (index + 1) + ". " + item;
        el.steal.append(line);
      });
    }
    const choosingItem = itemMenuOpen || state.stealOptions.length > 0;
    el.commandForm.hidden = !choosingItem;
    el.commandPrompt.textContent = state.stealOptions.length ? "Steal item number:" : "Item number:";
    el.commandInput.disabled = !canAct;
    if (choosingItem && canAct) el.commandInput.focus();

    el.turn.textContent = state.status === "finished"
      ? "(" + (state.winner || "A player") + " wins.)"
      : "(" + (state.turnUsername || "Opponent") + "'s turn)";
    el.leave.textContent = "4. Leave the room";
    el.leave.classList.add("pvp-terminal-action");

    const previousEventLog = el.events;
    const wasAtEventLogBottom = previousEventLog.scrollHeight - previousEventLog.clientHeight - previousEventLog.scrollTop < 24;
    const previousScrollTop = previousEventLog.scrollTop;
    el.events.replaceChildren();
    state.events.slice(-8).forEach((message) => {
      const line = document.createElement("p");
      line.className = "pvp-event-line";
      line.textContent = "> " + message;
      el.events.append(line);
    });
    if (wasAtEventLogBottom) el.events.scrollTop = el.events.scrollHeight;
    else el.events.scrollTop = previousScrollTop;
    el.shootOpponent.disabled = !canAct || state.stealOptions.length > 0;
    el.shootSelf.disabled = !canAct || state.stealOptions.length > 0;
    el.actionPrompt = byId("pvp-action-prompt");
    el.actionPrompt.textContent = state.status === "finished" ? "MATCH COMPLETE." : "SELECT AN ACTION:";
  }

  el.commandForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const command = el.commandInput.value.trim();
    el.commandInput.value = "";
    if (!latestGame || actionPending) return;
    if (latestGame.stealOptions.length) {
      const index = Number(command) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= latestGame.stealOptions.length) {
        sendAction({ type: "steal:invalid" });
        return;
      }
      sendAction({ type: "steal", itemIndex: index });
      return;
    }
    const own = latestGame.players.find((player) => player.isYou);
    const availableItems = ITEM_ORDER.filter((item) => own?.inventory.includes(item));
    if (command === "0") {
      itemMenuOpen = false;
      pendingMenuSelection = null;
      renderGame(latestGame);
      return;
    }
    const selection = Number(command) - 1;
    if (!Number.isInteger(selection) || selection < 0 || selection >= availableItems.length) {
      sendAction({ type: "item:invalid" });
      return;
    }
    const item = availableItems[selection];
    const itemIndex = own.inventory.indexOf(item);
    pendingMenuSelection = { item, count: own.inventory.filter((candidate) => candidate === item).length };
    sendAction({ type: "item", itemIndex });
  });
  el.keypad.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const key = button.dataset.key;
    if (key === "enter") el.commandForm.requestSubmit();
    else if (key === "clear") el.commandInput.value = "";
    else if (key === "backspace") el.commandInput.value = el.commandInput.value.slice(0, -1);
    else el.commandInput.value += key;
    el.commandInput.focus();
  });

  el.wagerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const stake = Number(el.wagerStake.value);
    if (!Number.isSafeInteger(stake) || stake < 10 || stake > 1000) {
      setMessage("Choose a whole-number stake between $10 and $1,000.");
      return;
    }
    if (!activeRoomCode || !socket?.connected) return setMessage("Connect to a room before proposing a bet.");
    socket.emit("wager:propose", { code: activeRoomCode, stake });
    setMessage("Sending your wager proposal...");
  });
  el.wagerAccept.addEventListener("click", () => {
    if (socket?.connected && activeRoomCode) socket.emit("wager:respond", { code: activeRoomCode, accepted: true });
  });
  el.wagerDecline.addEventListener("click", () => {
    if (socket?.connected && activeRoomCode) socket.emit("wager:respond", { code: activeRoomCode, accepted: false });
  });

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

  function showMode(mode) {
    const multiplayer = mode === "multiplayer";
    document.body.classList.toggle("story-active", !multiplayer);
    panel.hidden = !multiplayer;
    storyMode.hidden = multiplayer;
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

  el.reconnect.addEventListener("click", () => {
    const connection = ensureSocket();
    if (!connection) return;
    setMessage("Reconnecting to multiplayer server…");
    el.reconnect.disabled = true;
    connection.connect();
    window.setTimeout(() => { el.reconnect.disabled = false; }, 1500);
  });

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
    if (!emitWhenConnected("room:create", {})) {
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
    if (!emitWhenConnected("room:join", { code })) {
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
    if (!isHost || !socket?.connected || !activeRoomCode || el.start.disabled || currentWager?.status !== "locked") return;
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
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      if (!el.joinForm.hidden) {
        el.joinForm.hidden = true;
        el.joinOpen.hidden = false;
        el.joinOpen.focus();
        return;
      }
      showMode("story");
      if (window.buckshotGame) {
        window.buckshotGame.mode = "menu";
        window.buckshotGame.render();
      }
      return;
    }
    if (panel.hidden || storyMode.hidden === false) return;

    const target = event.target;
    const isTyping = target instanceof HTMLElement && (
      target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
    );
    if (isTyping) return;

    const key = event.key;
    let action = null;

    if (!el.game.hidden) {
      if (key === "1") action = el.shootOpponent;
      else if (key === "2") action = el.shootSelf;
      else if (key === "3") action = el.inventory.querySelector("button");
      else if (key === "4") action = el.leave;
    } else if (el.room.hidden) {
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
    clearRoomExpiryCountdown();
    if (socket) socket.disconnect();
    socket = null;
    intentionalDisconnect = false;
    activeRoomCode = null;
    pendingRequest = null;
    isHost = false;
    latestGame = null;
    currentWager = null;
    identityReady = false;
    el.game.hidden = true;
    el.start.hidden = true;
    el.room.hidden = true;
    el.request.hidden = true;
    showIdentity();
    setMessage("You left the multiplayer lobby.");
  });

  showIdentity();
})();