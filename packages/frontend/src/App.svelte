<script lang="ts">
  import { onMount } from "svelte";
  import { ECONOMY, type Player, type Room, type LobbyState, type GameView, type AnswerValue, type HintType, type PurchaseHintResponse, type AIActivityStatus } from "@tebakani/shared";

  const STORAGE_KEY = "tebakani_session";

  // Svelte 5 runes state
  let currentRoom = $state<Room | null>(null);
  let currentPlayer = $state<Player | null>(null);
  let sessionToken = $state<string | null>(null);
  let players = $state<Player[]>([]);
  let activeGame = $state<GameView | null>(null);

  // Form states
  let createName = $state("");
  let joinCode = $state("");
  let joinName = $state("");
  let aiPlayerName = $state("");

  // Turn action form states
  let questionInput = $state("");
  let guessInput = $state("");
  let isSubmittingAction = $state(false);
  let isRetryingModerator = $state(false);
  let submittingHint = $state<HintType | null>(null);

  // Status & Connection states
  let errorMsg = $state<string | null>(null);
  let actionSuccessMsg = $state<string | null>(null);
  let wsStatus = $state<"disconnected" | "connecting" | "connected">("disconnected");
  let socket: WebSocket | null = null;
  let isStartingGame = $state(false);
  let hasExplicitlyLeft = $state(false);

  // Failed image trackers (ID set) to hide broken images
  let failedImages = $state<Record<string, boolean>>({});

  function resetFormErrors() {
    errorMsg = null;
    actionSuccessMsg = null;
  }

  async function parseActionResponse<T>(res: Response): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      if (res.ok) return { ok: true, data: null as T };
      return { ok: false, error: `Server error (${res.status})` };
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: res.ok ? "Unexpected empty response" : `Server error (${res.status})` };
    }
    if (!res.ok) return { ok: false, error: body?.error || `Server error (${res.status})` };
    return { ok: true, data: body as T };
  }

  function mergeGameState(incoming: GameView) {
    if (!activeGame || activeGame.id !== incoming.id || activeGame.roomId !== incoming.roomId || incoming.revision >= activeGame.revision) {
      activeGame = incoming;
    }
  }

  function persistSession(room: Room, player: Player, token: string) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          room,
          player,
          sessionToken: token
        })
      );
    } catch {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  async function handleCreateRoom(e: SubmitEvent) {
    e.preventDefault();
    resetFormErrors();
    hasExplicitlyLeft = false;

    if (!createName.trim()) {
      errorMsg = "Player name is required";
      return;
    }

    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerName: createName.trim()
        })
      });

      const result = await parseActionResponse<{ room: Room; player: Player; sessionToken: string }>(res);
      if (!result.ok) {
        errorMsg = result.error;
        return;
      }
      const data = result.data;

      currentRoom = data.room;
      currentPlayer = data.player;
      sessionToken = data.sessionToken;
      players = [data.player];
      activeGame = null;

      persistSession(data.room, data.player, data.sessionToken);
      connectWebSocket(data.sessionToken);
    } catch (err: any) {
      errorMsg = err.message || "Network error occurred";
    }
  }

  async function handleJoinRoom(e: SubmitEvent) {
    e.preventDefault();
    resetFormErrors();
    hasExplicitlyLeft = false;

    const code = joinCode.trim().toUpperCase();
    if (!code) {
      errorMsg = "Room code is required";
      return;
    }
    if (!joinName.trim()) {
      errorMsg = "Player name is required";
      return;
    }

    try {
      const res = await fetch(`/api/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerName: joinName.trim()
        })
      });

      const result = await parseActionResponse<{ room: Room; player: Player; sessionToken: string }>(res);
      if (!result.ok) {
        errorMsg = result.error;
        return;
      }
      const data = result.data;

      currentRoom = data.room;
      currentPlayer = data.player;
      sessionToken = data.sessionToken;
      activeGame = null;

      persistSession(data.room, data.player, data.sessionToken);
      connectWebSocket(data.sessionToken);
    } catch (err: any) {
      errorMsg = err.message || "Network error occurred";
    }
  }

  async function fetchCurrentGameState(code: string, token: string) {
    try {
      const res = await fetch(`/api/rooms/${code}/game`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.ok) {
        const gameData: GameView = await res.json();
        mergeGameState(gameData);
      }
    } catch (err) {
      console.error("Failed to fetch game state over REST", err);
    }
  }

  async function handleStartGame() {
    if (!currentRoom || !sessionToken || !currentPlayer?.isHost) return;
    resetFormErrors();
    isStartingGame = true;

    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        }
      });

      const result = await parseActionResponse<GameView>(res);
      if (!result.ok) {
        errorMsg = result.error;
      } else {
        await fetchCurrentGameState(currentRoom.code, sessionToken);
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error starting game";
    } finally {
      isStartingGame = false;
    }
  }

  // Milestone 3 Turn Actions
  async function handleAskQuestion(e: SubmitEvent) {
    e.preventDefault();
    if (!currentRoom || !sessionToken || !questionInput.trim() || !activeGame?.currentTurn?.id) return;
    resetFormErrors();
    isSubmittingAction = true;

    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/question`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          expectedTurnId: activeGame.currentTurn.id,
          question: questionInput.trim()
        })
      });

      const result = await parseActionResponse<GameView>(res);
      if (!result.ok) {
        errorMsg = result.error;
      } else {
        questionInput = "";
        mergeGameState(result.data);
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error submitting question";
    } finally {
      isSubmittingAction = false;
    }
  }

  async function handleAnswer(answer: AnswerValue) {
    if (!currentRoom || !sessionToken || !activeGame?.currentTurn?.id) return;
    resetFormErrors();
    isSubmittingAction = true;

    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          expectedTurnId: activeGame.currentTurn.id,
          answer
        })
      });

      const result = await parseActionResponse<GameView>(res);
      if (!result.ok) {
        errorMsg = result.error;
      } else {
        mergeGameState(result.data);
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error submitting answer";
    } finally {
      isSubmittingAction = false;
    }
  }

  async function handleCloseAnswers() {
    if (!currentRoom || !sessionToken || !activeGame?.currentTurn?.id) return;
    resetFormErrors();
    isSubmittingAction = true;

    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/close-answers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          expectedTurnId: activeGame.currentTurn.id
        })
      });

      const result = await parseActionResponse<GameView>(res);
      if (!result.ok) {
        errorMsg = result.error;
      } else {
        mergeGameState(result.data);
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error closing answers";
    } finally {
      isSubmittingAction = false;
    }
  }

  async function handleGuess(e: SubmitEvent) {
    e.preventDefault();
    if (!currentRoom || !sessionToken || !guessInput.trim() || !activeGame?.currentTurn?.id) return;
    resetFormErrors();
    isSubmittingAction = true;

    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/guess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          expectedTurnId: activeGame.currentTurn.id,
          characterName: guessInput.trim()
        })
      });

      const result = await parseActionResponse<{ correct: boolean; game: GameView }>(res);
      if (!result.ok) {
        errorMsg = result.error;
      } else {
        guessInput = "";
        mergeGameState(result.data.game);
        if (result.data.correct) {
          actionSuccessMsg = "Congratulations! You guessed your character correctly!";
        } else {
          errorMsg = "Incorrect guess! Turn passed to next player.";
        }
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error submitting guess";
    } finally {
      isSubmittingAction = false;
    }
  }

  async function handlePass() {
    if (!currentRoom || !sessionToken || !activeGame?.currentTurn?.id) return;
    resetFormErrors();
    isSubmittingAction = true;

    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/pass`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          expectedTurnId: activeGame.currentTurn.id
        })
      });

      const result = await parseActionResponse<GameView>(res);
      if (!result.ok) {
        errorMsg = result.error;
      } else {
        mergeGameState(result.data);
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error passing turn";
    } finally {
      isSubmittingAction = false;
    }
  }

  async function handleSkipAiTurn() {
    if (!currentRoom || !sessionToken || !currentPlayer?.isHost || !activeGame?.currentTurn?.id) return;
    resetFormErrors();
    isSubmittingAction = true;

    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/skip-ai-turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          expectedTurnId: activeGame.currentTurn.id
        })
      });

      const result = await parseActionResponse<GameView>(res);
      if (!result.ok) {
        errorMsg = result.error;
      } else {
        mergeGameState(result.data);
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error skipping AI turn";
    } finally {
      isSubmittingAction = false;
    }
  }

  async function handleAddAIPlayer(e: SubmitEvent) {
    e.preventDefault();
    if (!currentRoom || !sessionToken) return;
    resetFormErrors();
    const requestedName = aiPlayerName.trim();
    const res = await fetch(`/api/rooms/${currentRoom.code}/ai-players`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ players: [{ name: requestedName || null }] })
    });
    const result = await parseActionResponse<{ players: Player[] } | null>(res);
    if (!result.ok) errorMsg = result.error;
    else aiPlayerName = "";
  }

  async function handleRemoveAIPlayer(playerId: string) {
    if (!currentRoom || !sessionToken) return;
    resetFormErrors();
    const res = await fetch(`/api/rooms/${currentRoom.code}/ai-players/${playerId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionToken}` }
    });
    if (!res.ok) {
      const result = await parseActionResponse<never>(res);
      errorMsg = result.ok ? "Failed to remove AI player" : result.error;
    }
  }

  async function handleRetryModerator() {
    if (!currentRoom || !sessionToken || !activeGame?.currentTurn || isSubmittingAction) return;
    resetFormErrors();
    isSubmittingAction = true;
    isRetryingModerator = true;
    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/moderator/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ expectedTurnId: activeGame.currentTurn.id })
      });
      const result = await parseActionResponse<GameView>(res);
      if (!result.ok) errorMsg = result.error;
      else activeGame = result.data;
    } catch (err: any) {
      errorMsg = err.message || "Network error retrying moderator";
    } finally {
      isSubmittingAction = false;
      isRetryingModerator = false;
    }
  }

  async function handlePurchaseHint(type: HintType) {
    if (!currentRoom || !sessionToken || !activeGame?.currentTurn || submittingHint) return;
    resetFormErrors();
    submittingHint = type;
    try {
      const res = await fetch(`/api/rooms/${currentRoom.code}/game/hints`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ expectedTurnId: activeGame.currentTurn.id, type })
      });
      const result = await parseActionResponse<PurchaseHintResponse>(res);
      if (!result.ok) errorMsg = result.error;
      else {
        const r = result.data;
        mergeGameState(r.game);
        actionSuccessMsg = `${type[0].toUpperCase()}${type.slice(1)} hint purchased for ${r.hint.cost} ${r.hint.cost === 1 ? "point" : "points"}.`;
      }
    } catch (err: any) {
      errorMsg = err.message || "Network error purchasing hint";
    } finally {
      submittingHint = null;
    }
  }

  function connectWebSocket(token: string) {
    if (hasExplicitlyLeft) return;

    if (socket) {
      socket.close();
      socket = null;
    }

    wsStatus = "connecting";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    socket = ws;

    ws.onopen = () => {
      wsStatus = "connected";
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "lobby_update") {
          const lobby = msg.data as LobbyState;
          players = lobby.players;
          currentRoom = lobby.room;
        } else if (msg.type === "game_started" || msg.type === "game_state" || msg.type === "game_finished") {
          mergeGameState(msg.data as GameView);
        } else if (msg.type === "error") {
          errorMsg = msg.error;
        }
      } catch (err) {
        console.error("Failed to parse websocket message", err);
      }
    };

    ws.onclose = () => {
      wsStatus = "disconnected";
    };

    ws.onerror = () => {
      wsStatus = "disconnected";
    };
  }

  function leaveRoom() {
    hasExplicitlyLeft = true;
    if (socket) {
      socket.close();
      socket = null;
    }
    currentRoom = null;
    currentPlayer = null;
    sessionToken = null;
    players = [];
    activeGame = null;
    wsStatus = "disconnected";
    failedImages = {};
    clearSession();
    resetFormErrors();
  }

  let restoreGeneration = 0;

  async function restoreSession() {
    restoreGeneration++;
    const currentGen = restoreGeneration;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed?.room?.code || !parsed?.player?.id || !parsed?.sessionToken) {
        clearSession();
        return;
      }

      let lobbyRes: Response;
      try {
        lobbyRes = await fetch(`/api/rooms/${parsed.room.code}`);
      } catch {
        return;
      }

      if (currentGen !== restoreGeneration) return;

      if (lobbyRes.status === 404) {
        clearSession();
        return;
      }

      if (lobbyRes.ok) {
        const lobbyData: LobbyState = await lobbyRes.json();
        if (currentGen !== restoreGeneration) return;

        currentRoom = lobbyData.room;
        currentPlayer = parsed.player;
        sessionToken = parsed.sessionToken;
        players = lobbyData.players;

        try {
          const gameRes = await fetch(`/api/rooms/${parsed.room.code}/game`, {
            headers: {
              Authorization: `Bearer ${parsed.sessionToken}`
            }
          });

          if (currentGen !== restoreGeneration) return;

          if (gameRes.status === 401) {
            clearSession();
            currentRoom = null;
            currentPlayer = null;
            sessionToken = null;
            return;
          }

          if (gameRes.ok) {
            mergeGameState(await gameRes.json());
          }
        } catch {}

        if (currentGen === restoreGeneration && !hasExplicitlyLeft) {
          connectWebSocket(parsed.sessionToken);
        }
      }
    } catch {
      clearSession();
    }
  }

  function handleImageError(playerId: string) {
    failedImages[playerId] = true;
  }

  function getAIActivityText(playerName: string, status: AIActivityStatus): string {
    const messages: Record<AIActivityStatus, string> = {
      thinking: `${playerName} · AI Player · Thinking…`,
      answering: `${playerName} is answering…`,
      choosing_hint: `${playerName} is choosing a hint…`,
      asking: `${playerName} is choosing a question…`,
      waiting: `${playerName} is waiting for answers…`,
      guessing: `${playerName} is analyzing the answers…`
    };
    return messages[status];
  }

  let currentAIActivity = $derived.by(() => {
    const activity = activeGame?.aiActivity[0];
    if (!activity) return null;
    const player = activeGame?.players.find(item => item.playerId === activity.playerId);
    if (!player || player.playerType !== "ai") return null;
    return { ...activity, playerName: player.playerName, text: getAIActivityText(player.playerName, activity.status) };
  });

  let lastAIActionText = $derived.by(() => {
    const action = activeGame?.lastAIAction;
    if (!action || action.action === "answered" || action.action === "hint_purchased" || action.action === "question_asked") return "";
    const player = activeGame?.players.find(item => item.playerId === action.playerId);
    if (!player || player.playerType !== "ai") return "";
    if (action.action === "passed") return `${player.playerName} passed.`;
    if (action.outcome === "correct") return `${player.playerName} guessed the character correctly.`;
    if (action.outcome === "incorrect") return `${player.playerName} guessed incorrectly.`;
    return `${player.playerName} made a guess.`;
  });

  let aiLiveStatus = $derived(currentAIActivity?.text ?? lastAIActionText);

  onMount(() => {
    restoreSession();
    return () => {
      restoreGeneration++;
      if (socket) {
        socket.close();
        socket = null;
      }
    };
  });
</script>

<main id="main-content" tabindex="-1" class="mx-auto my-4 w-[calc(100%-2rem)] max-w-6xl overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-2xl sm:my-8">
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{aiLiveStatus}</div>
  <header class="bg-neutral px-5 py-8 text-center text-neutral-content sm:px-8">
    <h1 class="flex items-center justify-center gap-2 bg-gradient-to-r from-neutral-content via-accent to-neutral-content bg-clip-text text-4xl font-black tracking-tight text-transparent sm:text-5xl"><span class="icon-[material-symbols--stadia-controller-rounded] text-neutral-content" aria-hidden="true"></span>TebakAni</h1>
    <p class="mt-2 text-sm font-medium text-neutral-content sm:text-base">Realtime Anime Guessing Game</p>
  </header>

  <div class="space-y-5 p-4 sm:p-6 lg:p-8">
  {#if errorMsg}
    <div class="alert alert-error mb-5 items-start shadow-md" role="alert">
      <span>{errorMsg}</span>
      <button type="button" class="btn btn-ghost btn-sm min-h-11" onclick={() => (errorMsg = null)}><span class="icon-[material-symbols--close-rounded]" aria-hidden="true"></span>Dismiss</button>
    </div>
  {/if}

  {#if actionSuccessMsg}
    <div class="alert alert-success mb-5 items-start shadow-md" role="status">
      <span>{actionSuccessMsg}</span>
      <button type="button" class="btn btn-ghost btn-sm min-h-11" onclick={() => (actionSuccessMsg = null)}>Dismiss</button>
    </div>
  {/if}

  {#if !currentRoom}
    <div class="grid gap-6 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
      <section class="card border border-base-300 bg-base-100 shadow-lg"><div class="card-body">
        <h2 class="card-title text-2xl"><span class="icon-[material-symbols--add-home-rounded] text-primary" aria-hidden="true"></span>Create Room</h2>
        <form class="mt-4 space-y-4" onsubmit={handleCreateRoom}>
          <div class="fieldset w-full gap-2">
            <label for="create-name">Player Name</label>
            <input
              class="input input-bordered min-h-11 w-full text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              id="create-name"
              type="text"
              maxlength="30"
              required
              placeholder="e.g. Shinji"
              bind:value={createName}
            />
          </div>

          <button type="submit" class="btn btn-primary min-h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"><span class="icon-[material-symbols--add-rounded]" aria-hidden="true"></span>Create Room</button>
        </form>
        </div>
      </section>

      <hr class="divider md:divider-horizontal" />

      <section class="card border border-base-300 bg-base-100 shadow-lg"><div class="card-body">
        <h2 class="card-title text-2xl"><span class="icon-[material-symbols--login-rounded] text-secondary" aria-hidden="true"></span>Join Room</h2>
        <form class="mt-4 space-y-4" onsubmit={handleJoinRoom}>
          <div class="fieldset w-full gap-2">
            <label for="join-code">Room Code (6 chars)</label>
            <input
              id="join-code"
              type="text"
              maxlength="6"
              required
              placeholder="e.g. 7XKM9P"
              bind:value={joinCode}
              class="input input-bordered min-h-11 w-full font-mono text-base uppercase tracking-[0.2em] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <div class="fieldset w-full gap-2">
            <label for="join-name">Player Name</label>
            <input
              id="join-name"
              type="text"
              maxlength="30"
              required
              placeholder="e.g. Asuka"
              bind:value={joinName}
              class="input input-bordered min-h-11 w-full text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <button type="submit" class="btn btn-secondary min-h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary"><span class="icon-[material-symbols--group-add-rounded]" aria-hidden="true"></span>Join Room</button>
        </form>
        </div>
      </section>
    </div>
  {:else}
    <section class="space-y-6">
      <div class="flex flex-col gap-4 border-b border-base-300 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span class="badge badge-ghost badge-sm font-bold uppercase tracking-wider">Room Code</span>
          <h2 class="mt-1 font-mono text-3xl font-black tracking-[0.18em] text-primary sm:text-4xl">{currentRoom.code}</h2>
        </div>
        <div class="flex min-h-11 flex-wrap items-center gap-2 text-sm capitalize">
          <span class={wsStatus === "connected" ? "status status-success" : wsStatus === "connecting" ? "status status-warning" : "status status-error"} aria-hidden="true"></span>
          <span class="font-semibold">{wsStatus}</span>
          {#if wsStatus === "disconnected" && sessionToken && !hasExplicitlyLeft}
            <button
              type="button"
              class="btn btn-primary btn-sm min-h-11"
              onclick={() => connectWebSocket(sessionToken!)}
            >
              <span class="icon-[material-symbols--sync-rounded]" aria-hidden="true"></span>
              Reconnect
            </button>
          {/if}
        </div>
      </div>

      {#if activeGame}
        <!-- Active Game Screen -->
        <div class="space-y-5">
          <div class="alert flex-col items-start gap-3 border border-primary bg-primary/15 text-base-content shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span class="text-sm font-medium">Game Status:</span>
              <strong class="ml-1 text-primary">{activeGame.status.toUpperCase()}</strong>
            </div>

            {#if activeGame.status === "playing" && activeGame.currentTurn}
              <div class="flex flex-wrap items-center gap-2 text-sm">
                Turn #{activeGame.currentTurn.turnNumber}:
                <strong>{activeGame.currentTurn.activePlayerName}</strong>
                {#if activeGame.currentTurn.activePlayerId === currentPlayer?.id}
                  <span class="badge badge-secondary badge-sm font-black">YOUR TURN</span>
                {/if}
              </div>
            {:else if activeGame.status === "finished"}
              <div class="flex items-center gap-2 font-bold text-base-content">
                <strong>GAME FINISHED!</strong>
              </div>
            {/if}
          </div>

          {#if currentAIActivity || lastAIActionText}
            <section class="card border border-warning/40 bg-warning/10 shadow-sm" aria-labelledby="ai-player-status-heading" aria-busy={currentAIActivity !== null}>
              <div class="card-body gap-2 p-4">
                <h3 id="ai-player-status-heading" class="flex items-center gap-2 font-bold">
                  <span class="icon-[material-symbols--smart-toy-rounded] text-warning" aria-hidden="true"></span>
                  AI player activity
                </h3>
                {#if currentAIActivity}
                  <p class="font-medium">{currentAIActivity.text}</p>
                  <progress class="progress progress-warning w-full" aria-label={currentAIActivity.text}></progress>
                {/if}
                {#if lastAIActionText}
                  <p class="text-sm text-base-content/80">Last action: {lastAIActionText}</p>
                {/if}
              </div>
            </section>
          {/if}

          <!-- Turn Interaction Area -->
          {#if activeGame.status === "playing" && activeGame.currentTurn}
            {@const currentTurn = activeGame.currentTurn}
            {@const isMyTurn = currentTurn.activePlayerId === currentPlayer?.id}
            {@const selfState = activeGame.players.find(p => p.playerId === currentPlayer?.id)}
            {@const canViewHintShop = isMyTurn && selfState?.playerType === "human" && !selfState.hasGuessedCorrectly && ["waiting_for_question", "collecting_answers", "awaiting_guess"].includes(currentTurn.phase)}

            <section class="grid gap-3 lg:grid-cols-[auto_1fr]" aria-labelledby="own-economy-heading">
              <div class="card border border-primary/40 bg-primary/10 shadow-sm">
                <div class="card-body gap-1 p-4">
                  <h3 id="own-economy-heading" class="text-sm font-bold">Your points</h3>
                  <p class="text-3xl font-black text-primary">{selfState?.pointBalance ?? 0}</p>
                </div>
              </div>

              <div class="card border border-base-300 bg-base-100 shadow-sm">
                <div class="card-body gap-3 p-4">
                  <div class="grid gap-3 sm:grid-cols-2">
                    <section aria-labelledby="own-hints-heading">
                      <h3 id="own-hints-heading" class="font-bold">Your hints</h3>
                      {#if activeGame.ownHints.length}
                        <ul class="mt-2 space-y-2" role="list">
                          {#each activeGame.ownHints as hint (hint.id)}
                            <li class="rounded-box bg-base-200 px-3 py-2 text-sm">
                              <strong class="capitalize">{hint.type}:</strong>
                              {#if Array.isArray(hint.value)}
                                <span>{hint.value.join(", ")}</span>
                              {:else}
                                <span>{hint.value}</span>
                              {/if}
                            </li>
                          {/each}
                        </ul>
                      {:else}
                        <p class="mt-1 text-sm text-base-content/80">No hints purchased.</p>
                      {/if}
                    </section>

                    <section aria-labelledby="own-ledger-heading">
                      <h3 id="own-ledger-heading" class="font-bold">Your ledger</h3>
                      {#if activeGame.ownLedger.length}
                        <ul class="mt-2 flex flex-wrap gap-2" role="list">
                          {#each activeGame.ownLedger as entry (entry.id)}
                            <li class={entry.amount > 0 ? "badge badge-success h-auto py-1 font-bold" : "badge badge-warning h-auto py-1 font-bold"}>
                              {entry.reason === "answer_match" ? "Answer match" : "Hint purchase"} {entry.amount > 0 ? "+" : ""}{entry.amount}
                            </li>
                          {/each}
                        </ul>
                      {:else}
                        <p class="mt-1 text-sm text-base-content/80">No point activity.</p>
                      {/if}
                    </section>
                  </div>
                </div>
              </div>
            </section>

            {#if canViewHintShop}
              <section class="card border border-secondary/40 bg-secondary/10 shadow-sm" aria-labelledby="hint-shop-heading">
                <div class="card-body gap-3 p-4">
                  <div>
                    <h3 id="hint-shop-heading" class="font-bold">Hint shop</h3>
                    <p class="text-sm text-base-content/80">Spend points to reveal private clues. Purchased hints remain visible only to you.</p>
                  </div>
                  <ul class="grid gap-2 sm:grid-cols-3" role="list">
                    {#each (["basic", "series", "candidates"] as HintType[]) as type}
                      {@const cost = ECONOMY.hintCosts[type]}
                      {@const purchased = activeGame.ownHints.some(hint => hint.type === type)}
                      {@const insufficient = (selfState?.pointBalance ?? 0) < cost}
                      {@const unavailablePhase = currentTurn.phase === "waiting_for_question"}
                      <li>
                        <button
                          type="button"
                          class="btn btn-secondary btn-outline min-h-11 w-full"
                          disabled={purchased || insufficient || unavailablePhase || submittingHint !== null}
                          onclick={() => handlePurchaseHint(type)}
                        >
                          {#if submittingHint === type}
                            <span class="loading loading-spinner loading-sm" aria-hidden="true"></span>
                            Submitting…
                          {:else if purchased}
                            {type === "basic" ? "Basic" : type === "series" ? "Series" : "Candidates"} · Purchased
                          {:else if insufficient}
                            {type === "basic" ? "Basic" : type === "series" ? "Series" : "Candidates"} · {cost} · Insufficient
                          {:else if unavailablePhase}
                            {type === "basic" ? "Basic" : type === "series" ? "Series" : "Candidates"} · {cost} · After question
                          {:else}
                            Buy {type === "basic" ? "Basic" : type === "series" ? "Series" : "Candidates"} · {cost}
                          {/if}
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
              </section>
            {/if}

            <div class="card border border-base-300 bg-base-200 shadow-xl"><div class="card-body gap-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="badge badge-neutral h-auto min-h-7 py-1 font-bold tracking-wide">Phase: {currentTurn.phase.replace(/_/g, " ").toUpperCase()}</span>
                {#if currentPlayer?.isHost && currentTurn.activePlayerType === "ai"}
                  <div class="flex flex-col items-end gap-1">
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm min-h-11 text-warning focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warning"
                      disabled={isSubmittingAction}
                      aria-describedby="skip-ai-turn-help"
                      onclick={handleSkipAiTurn}
                    >
                      <span class="icon-[material-symbols--skip-next-rounded]" aria-hidden="true"></span>
                      Emergency: Skip AI Turn
                    </button>
                    <span id="skip-ai-turn-help" class="text-xs text-base-content/70">Recovery only if the AI turn is stuck.</span>
                  </div>
                {/if}
              </div>

              {#if selfState?.hasGuessedCorrectly}
                <div class="alert alert-success text-sm">
                  <span>You have completed your guessing! Spectating other players.</span>
                </div>
              {/if}

              <!-- 1. Waiting for question -->
              {#if currentTurn.phase === "waiting_for_question"}
                {#if isMyTurn && currentPlayer?.type === "human"}
                  <form class="space-y-4" onsubmit={handleAskQuestion}>
                    <div class="fieldset w-full gap-2">
                      <label for="turn-question">Ask a Yes/No/Maybe question about your character:</label>
                      <input
                        id="turn-question"
                        type="text"
                        maxlength="200"
                        required
                        placeholder="e.g. Does my character have superpowers?"
                        bind:value={questionInput}
                        class="input input-bordered min-h-11 w-full text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      />
                    </div>
                    <button type="submit" class="btn btn-primary min-h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" disabled={isSubmittingAction}>
                      {#if isSubmittingAction}
                        <span class="icon-[material-symbols--progress-activity] animate-spin motion-reduce:animate-none" aria-hidden="true"></span>
                        Submitting...
                      {:else}
                        <span class="icon-[material-symbols--help-rounded]" aria-hidden="true"></span>
                        Ask Question
                      {/if}
                    </button>
                  </form>
                {:else if isMyTurn && currentPlayer?.type === "ai"}
                  <div class="alert alert-info text-sm italic">
                    Current active player is AI (Host can skip turn).
                  </div>
                {:else}
                  <div class="alert alert-info text-sm italic">
                    Waiting for <strong>{currentTurn.activePlayerName}</strong> to ask a question...
                  </div>
                {/if}

              <!-- 2. Collecting answers -->
              {:else if currentTurn.phase === "collecting_answers" && currentTurn.question}
                {@const q = currentTurn.question}
                <div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
                  <span class="text-xs font-bold uppercase tracking-wider text-base-content/80">Question:</span>
                  <p class="mt-1 text-lg font-bold text-base-content">"{q.questionText}"</p>
                </div>

                <div class="alert border border-base-300 bg-base-100 text-sm" role="status" aria-live="polite" aria-busy={q.moderatorStatus === "pending" || isRetryingModerator}>
                  {#if q.moderatorStatus === "pending" || isRetryingModerator}
                    <span class="icon-[material-symbols--psychology-rounded] animate-pulse text-primary motion-reduce:animate-none" aria-hidden="true"></span>
                    <span>{isRetryingModerator ? "Retrying…" : "AI moderator is thinking…"}</span>
                  {:else if q.moderatorStatus === "answered"}
                    <span class="icon-[material-symbols--check-circle-rounded] text-base-content" aria-hidden="true"></span>
                    AI moderator: <strong>{q.moderatorAnswer?.toUpperCase()}</strong>
                  {:else}
                    <span class="icon-[material-symbols--error-rounded] text-base-content" aria-hidden="true"></span>
                    AI moderator failed to answer.
                    {#if currentPlayer?.isHost || isMyTurn}
                      <button type="button" class="btn btn-warning btn-outline btn-sm min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warning" disabled={isSubmittingAction} onclick={handleRetryModerator}><span class="icon-[material-symbols--refresh-rounded]" aria-hidden="true"></span>Retry</button>
                    {/if}
                  {/if}
                </div>

                <!-- Answer options for non-active human players (including completed players) -->
                {#if !isMyTurn && currentPlayer?.type === "human"}
                  {@const myAnswer = q.answers.find(a => a.playerId === currentPlayer?.id)?.answer}
                  <div class="space-y-2">
                    <span class="fieldset-legend">Your Answer:</span>
                    <div class="grid grid-cols-3 gap-2">
                      {#each ["yes", "no", "maybe"] as AnswerValue[] as option}
                        <label class={myAnswer === option ? "btn btn-primary min-h-11 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary" : "btn min-h-11 border-base-300 bg-base-100 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary"}>
                          <input
                            type="radio"
                            name="player-answer"
                            value={option}
                            checked={myAnswer === option}
                            disabled={isSubmittingAction}
                            onchange={() => handleAnswer(option as AnswerValue)}
                            class="sr-only"
                          />
                          {option.toUpperCase()}
                        </label>
                      {/each}
                    </div>
                  </div>
                {/if}

                <!-- Answers List -->
                <div class="space-y-2">
                  <span class="text-sm font-semibold text-base-content/80">Responses ({q.answers.length}):</span>
                  <ul>
                    {#each q.answers as ans (ans.playerId)}
                      <li>
                        <span class="font-medium">{ans.playerName}:</span>
                        <span class={ans.answer === "yes" ? "badge badge-success badge-sm font-black" : ans.answer === "no" ? "badge badge-error badge-sm font-black" : "badge badge-warning badge-sm font-black"}>{ans.answer.toUpperCase()}</span>
                      </li>
                    {/each}
                  </ul>
                </div>

                <!-- Active player can close answers -->
                {#if isMyTurn}
                  <div class="grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      class="btn btn-secondary min-h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary"
                      disabled={isSubmittingAction || q.moderatorStatus !== "answered"}
                      onclick={handleCloseAnswers}
                    >
                      <span class="icon-[material-symbols--arrow-forward-rounded]" aria-hidden="true"></span>
                      Close Answers & Proceed to Guess
                    </button>
                    <button type="button" class="btn btn-outline min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" disabled={isSubmittingAction} onclick={handlePass}>
                      <span class="icon-[material-symbols--redo-rounded]" aria-hidden="true"></span>
                      Pass Turn
                    </button>
                  </div>
                {/if}

              <!-- 3. Awaiting guess -->
              {:else if currentTurn.phase === "awaiting_guess"}
                {#if currentTurn.question}
                  {@const settledQuestion = currentTurn.question}
                  <div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
                    <span class="text-xs font-bold uppercase tracking-wider text-base-content/80">Question:</span>
                    <p class="mt-1 text-lg font-bold text-base-content">"{settledQuestion.questionText}"</p>
                  </div>
                  <section class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm" aria-labelledby="settlement-heading">
                    <h3 id="settlement-heading" class="font-bold">Score settlement</h3>
                    <p class="mt-1 text-sm">Moderator answer: <strong>{settledQuestion.moderatorAnswer?.toUpperCase() ?? "Unavailable"}</strong></p>
                    {#if settledQuestion.answers.length}
                      <ul class="mt-3 space-y-2" role="list">
                        {#each settledQuestion.answers as answer (answer.playerId)}
                          {@const award = settledQuestion.awards.find(item => item.playerId === answer.playerId)}
                          <li class="flex flex-wrap items-center justify-between gap-2 rounded-box bg-base-200 px-3 py-2 text-sm">
                            <span><strong>{answer.playerName}</strong>: {answer.answer.toUpperCase()}</span>
                            <span class={award ? "badge badge-success font-bold" : "badge badge-ghost font-bold"}>{award ? `+${award.amount}` : "No point"}</span>
                          </li>
                        {/each}
                      </ul>
                    {:else}
                      <p class="mt-2 text-sm text-base-content/80">No answers submitted.</p>
                    {/if}
                  </section>
                {/if}

                {#if isMyTurn}
                  <div class="rounded-box border border-base-300 bg-base-100 p-4">
                    <form class="space-y-4" onsubmit={handleGuess}>
                      <div class="fieldset w-full gap-2">
                        <label for="turn-guess">Ready to guess your character name?</label>
                        <input
                          id="turn-guess"
                          type="text"
                          maxlength="100"
                          placeholder="e.g. Monkey D. Luffy"
                          bind:value={guessInput}
                          class="input input-bordered min-h-11 w-full text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        />
                      </div>
                      <div class="grid gap-3 sm:grid-cols-2">
                        <button type="submit" class="btn btn-primary min-h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" disabled={isSubmittingAction || !guessInput.trim()}>
                          <span class="icon-[material-symbols--search-rounded]" aria-hidden="true"></span>
                          {isSubmittingAction ? "Submitting..." : "Submit Guess"}
                        </button>
                        <button type="button" class="btn btn-outline min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" disabled={isSubmittingAction} onclick={handlePass}>
                          <span class="icon-[material-symbols--redo-rounded]" aria-hidden="true"></span>
                      Pass Turn
                        </button>
                      </div>
                    </form>
                  </div>
                {:else}
                  <div class="alert alert-info text-sm italic">
                    Waiting for <strong>{currentTurn.activePlayerName}</strong> to make a guess or pass...
                  </div>
                {/if}
              {/if}
              </div>
            </div>
          {/if}

          <h3 class="text-xl font-black">Player Roster & Status</h3>
          <ul class="grid gap-3 md:grid-cols-2" role="list">
            {#each activeGame.players as player (player.playerId)}
              <li class={player.isCurrentTurn ? "card border-2 border-primary bg-primary/10 shadow-lg" : "card border border-base-300 bg-base-100 shadow-md"}>
                <div class="card-body gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex min-w-0 items-center gap-3">
                  <div class="grid size-9 shrink-0 place-items-center rounded-full bg-base-200 text-sm font-black text-base-content/80">#{player.turnOrder + 1}</div>
                  <div class="min-w-0 space-y-1">
                    <span class="font-bold text-base-content">
                      {player.playerName}
                      {#if player.playerId === currentPlayer?.id}
                        <strong> (You)</strong>
                      {/if}
                    </span>
                    <div class="flex flex-wrap gap-1">
                      {#if player.playerType === "human"}
                        <span class="badge badge-primary badge-sm gap-1 font-bold"><span class="icon-[material-symbols--person-rounded]" aria-hidden="true"></span>HUMAN</span>
                      {:else}
                        <span class="badge badge-warning badge-sm gap-1 font-bold"><span class="icon-[material-symbols--smart-toy-rounded]" aria-hidden="true"></span>AI</span>
                      {/if}
                      <span class="badge badge-neutral badge-sm font-bold">{player.pointBalance} {player.pointBalance === 1 ? "POINT" : "POINTS"}</span>
                      {#if player.hasGuessedCorrectly}
                        <span class="badge badge-success badge-sm font-bold">COMPLETED</span>
                      {:else if player.isCurrentTurn}
                        <span class="badge badge-secondary badge-sm font-bold">CURRENT TURN</span>
                      {/if}
                    </div>
                  </div>
                </div>

                <div class="mt-3 flex justify-end border-t border-base-300 pt-3 sm:mt-0 sm:border-0 sm:pt-0">
                  {#if player.playerId === currentPlayer?.id && !player.hasGuessedCorrectly}
                    <div class="flex flex-col items-end rounded-box bg-primary/10 px-4 py-2" title="Your character is secret until you guess it">
                      <span class="text-xs text-base-content/80">Your Character:</span>
                      <span class="flex items-center gap-1 text-xl font-black tracking-widest text-primary"><span class="icon-[material-symbols--visibility-off-rounded]" aria-hidden="true"></span>???</span>
                    </div>
                  {:else if player.character}
                    <div class="flex items-center gap-3">
                      {#if player.character.imageUrl && !failedImages[player.playerId]}
                        <img
                          src={player.character.imageUrl}
                          alt={"Character image for " + player.character.name}
                          width="48"
                          height="48"
                          loading="lazy"
                          decoding="async"
                          class="size-14 rounded-box border border-base-300 object-cover shadow-sm"
                          onerror={() => handleImageError(player.playerId)}
                        />
                      {/if}
                      <div class="text-right">
                        <div class="font-bold text-base-content">{player.character.name}</div>
                        <div class="text-xs text-base-content/80">{player.character.series}</div>
                      </div>
                    </div>
                  {:else}
                    <span class="text-sm italic text-base-content/80">Unknown</span>
                  {/if}
                </div>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <!-- Pre-game Lobby Player List -->
        <div class="space-y-4">
          <h3 class="text-xl font-black">Lobby Players ({players.length})</h3>
          <ul class="grid gap-3 md:grid-cols-2" role="list">
            {#each players as player (player.id)}
              <li class="card flex-row items-center justify-between gap-3 border border-base-300 bg-base-100 p-4 shadow-md">
                <div class="min-w-0 space-y-2">
                  <span class="font-bold text-base-content">
                    {player.name}
                    {#if player.id === currentPlayer?.id}
                      <strong> (You)</strong>
                    {/if}
                  </span>
                  <div class="flex flex-wrap gap-1">
                    {#if player.type === "human"}
                      <span class="badge badge-primary badge-sm gap-1 font-bold"><span class="icon-[material-symbols--person-rounded]" aria-hidden="true"></span>HUMAN</span>
                    {:else}
                      <span class="badge badge-warning badge-sm gap-1 font-bold"><span class="icon-[material-symbols--smart-toy-rounded]" aria-hidden="true"></span>AI</span>
                    {/if}
                    {#if player.isHost}
                      <span class="badge badge-success badge-sm gap-1 font-bold"><span class="icon-[material-symbols--crown-rounded]" aria-hidden="true"></span>HOST</span>
                    {/if}
                  </div>
                </div>
                 <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
                   {#if player.type === "ai"}
                     <span class="text-xs font-medium text-base-content/80">Presence: N/A</span>
                     {#if currentPlayer?.isHost}
                       <button type="button" class="btn btn-warning btn-outline btn-sm min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warning" onclick={() => handleRemoveAIPlayer(player.id)}><span class="icon-[material-symbols--person-remove-rounded]" aria-hidden="true"></span>Remove</button>
                     {/if}
                   {:else}
                     <span class={player.connected ? "status status-success" : "status status-error"} aria-hidden="true"></span>
                      {#if player.connected}
                        <span class="flex items-center gap-1 text-xs font-medium text-base-content/80"><span class="icon-[material-symbols--wifi-rounded] text-success" aria-hidden="true"></span>Online</span>
                      {:else}
                        <span class="flex items-center gap-1 text-xs font-medium text-base-content/80"><span class="icon-[material-symbols--wifi-off-rounded] text-error" aria-hidden="true"></span>Offline</span>
                      {/if}
                   {/if}
                 </div>
              </li>
            {/each}
          </ul>

          {#if currentPlayer?.isHost}
            <div class="card gap-4 border border-secondary/40 bg-secondary/10 p-4 shadow-lg">
              <form class="space-y-2" onsubmit={handleAddAIPlayer}>
                <label for="ai-player-name">Add AI player <span class="text-base-content/80">(optional name)</span></label>
                <div class="grid gap-3 sm:grid-cols-2">
                  <input id="ai-player-name" maxlength="30" placeholder="Leave blank for automatic name" bind:value={aiPlayerName} class="input input-bordered min-h-11 w-full text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" />
                  <button type="submit" class="btn btn-secondary min-h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary"><span class="icon-[material-symbols--person-add-rounded]" aria-hidden="true"></span>Add AI</button>
                </div>
              </form>
              <button
                type="button"
                class="btn btn-primary min-h-11 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                disabled={players.length < 2 || isStartingGame}
                onclick={handleStartGame}
              >
                <span class="icon-[material-symbols--play-arrow-rounded]" aria-hidden="true"></span>
                {isStartingGame ? "Starting..." : players.length < 2 ? "Waiting for players (min 2)..." : "Start Game"}
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <div class="border-t border-base-300 pt-5">
        <button type="button" class="btn btn-outline min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" onclick={leaveRoom}><span class="icon-[material-symbols--logout-rounded]" aria-hidden="true"></span>Leave Room</button>
      </div>
    </section>
  {/if}
  </div>
</main>

