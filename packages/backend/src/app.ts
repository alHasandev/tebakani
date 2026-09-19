import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createDatabase } from "./db";
import { RoomRepository } from "./repository";
import { GameRepository } from "./game-repository";
import { TurnRepository } from "./turn-repository";
import { GameService } from "./game-service";
import { createCharacterSource } from "./production-character-source";
import { PresenceManager } from "./presence";
import { serializeGameForViewer } from "./game-serializer";
import { DomainError } from "./errors";
import type { CharacterSource, LobbyState, AnswerValue } from "@tebakani/shared";
import { createProductionModerator, type AIModerator } from "./ai-moderator";
import { EconomyRepository, HintService } from "./economy";
import type { AIPlayerAgent } from "./ai-player-types";
import { createProductionAIPlayerAgent } from "./ai-player-agent";
import { AIPlayerContextRepository } from "./ai-player-context";
import { AIPlayerRunner } from "./ai-player-runner";
import { defaultAIRuntime, loadAIPlayerConfig, type AIPlayerConfig, type AIRuntime } from "./ai-player-config";
import { AIActivityRepository } from "./ai-activity";

export interface AppDependencies {
  moderator?: AIModerator;
  aiPlayerAgent?: AIPlayerAgent;
  aiPlayerConfig?: AIPlayerConfig;
  aiRuntime?: AIRuntime;
}

class LazyProductionModerator implements AIModerator {
  private delegate?: AIModerator;

  moderate(request: Parameters<AIModerator["moderate"]>[0]) {
    this.delegate ??= createProductionModerator();
    return this.delegate.moderate(request);
  }
}

export class LazyProductionAIPlayerAgent implements AIPlayerAgent {
  private delegate?: AIPlayerAgent;
  constructor(private readonly createAgent: () => AIPlayerAgent = createProductionAIPlayerAgent) {}
  private get agent() { return this.delegate ??= this.createAgent(); }
  answerQuestion(context: Parameters<AIPlayerAgent["answerQuestion"]>[0], signal?: AbortSignal) { return this.agent.answerQuestion(context, signal); }
  decideHint(context: Parameters<AIPlayerAgent["decideHint"]>[0], signal?: AbortSignal) { return this.agent.decideHint(context, signal); }
  generateQuestion(context: Parameters<AIPlayerAgent["generateQuestion"]>[0], signal?: AbortSignal) { return this.agent.generateQuestion(context, signal); }
  decideGuessOrPass(context: Parameters<AIPlayerAgent["decideGuessOrPass"]>[0], signal?: AbortSignal) { return this.agent.decideGuessOrPass(context, signal); }
}

function parseBearerToken(headers: Record<string, string | undefined>): string | null {
  const authHeader = headers["authorization"] || headers["Authorization"];
  if (!authHeader) return null;
  const parts = authHeader.trim().split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1].trim();
  }
  return null;
}

export function createApp(
  dbPath = ":memory:",
  characterSource: CharacterSource | undefined = undefined,
  dependencies: AppDependencies = {}
) {
  const db = createDatabase(dbPath);
  characterSource ??= createCharacterSource(db);
  const repo = new RoomRepository(db);
  const gameRepo = new GameRepository(db);
  const turnRepo = new TurnRepository(db);
  const moderator = dependencies.moderator ?? new LazyProductionModerator();
  const economyRepo = new EconomyRepository(db);
  const hintService = new HintService(characterSource, economyRepo);
  const aiActivity = new AIActivityRepository(db);
  const gameService = new GameService(repo, gameRepo, turnRepo, characterSource, moderator, economyRepo, hintService, aiActivity);
  const presence = new PresenceManager();
  const evaluations = new Set<Promise<void>>();
  let stopping = false;
  const aiConfig = dependencies.aiPlayerConfig ?? loadAIPlayerConfig();
  const aiContexts = new AIPlayerContextRepository(db);
  let aiRunner: AIPlayerRunner;

  function scheduleEvaluation(code: string, questionId: string) {
    if (stopping) return;
    const task = gameService.evaluateQuestion(questionId, aiConfig.moderatorRetries + 1, () => stopping).then(() => { if (stopping) return; broadcastGameState(code); const room = repo.getRoomByCode(code); const game = room && gameRepo.getGameByRoomId(room.id); if (game) aiRunner.reconcile(game.id); }).finally(() => evaluations.delete(task));
    evaluations.add(task);
  }

  async function awaitEvaluations() {
    while (evaluations.size) await Promise.all([...evaluations]);
  }

  function broadcastGameState(code: string, isFinished = false) {
    const room = repo.getRoomByCode(code);
    if (!room) return;

    const game = gameRepo.getGameByRoomId(room.id);
    if (!game) return;

    const playerStates = gameRepo.getPlayerGameStates(game.id);
    const turnDetails = turnRepo.getActiveTurn(game.id);

    for (const ps of playerStates) {
      const viewerState = serializeGameForViewer(
        game,
        playerStates,
        ps.playerId,
        turnDetails,
        economyRepo.getLedger(game.id, ps.playerId),
        economyRepo.getHints(game.id, ps.playerId),
        aiActivity.get(game.id, turnDetails?.turn.id ?? null).activity,
        aiActivity.get(game.id, turnDetails?.turn.id ?? null).lastAction
      );
      app.server?.publish(
        `player:${ps.playerId}`,
        JSON.stringify({
          type: isFinished ? "game_finished" : "game_state",
          data: viewerState
        })
      );
    }
  }

  aiRunner = new AIPlayerRunner(gameRepo, turnRepo, gameService, aiContexts, aiActivity, dependencies.aiPlayerAgent ?? new LazyProductionAIPlayerAgent(), aiConfig, dependencies.aiRuntime ?? defaultAIRuntime, { stateChanged: broadcastGameState, evaluateQuestion: scheduleEvaluation });

  function stateChanged(code: string, finished = false) {
    broadcastGameState(code, finished);
    const room = repo.getRoomByCode(code);
    const game = room && gameRepo.getGameByRoomId(room.id);
    if (game) aiRunner.reconcile(game.id);
  }

  const app = new Elysia()
    .use(cors())
    .onStop(async () => { stopping = true; await aiRunner.stop(); await awaitEvaluations(); })
    .onError(({ error, code, set }) => {
      if (error instanceof DomainError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (code === "VALIDATION" || code === "PARSE") {
        set.status = 400;
        return { error: "Invalid request payload" };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "Route not found" };
      }
      set.status = 500;
      return { error: "Internal server error" };
    })
    .post(
      "/rooms",
      ({ body, set }) => {
        const playerName = body.playerName.trim();
        if (!playerName) {
          set.status = 400;
          return { error: "Player name cannot be empty" };
        }

        if (body.playerType === "ai") {
          throw new DomainError(403, "AI players must be managed by a human host");
        }
        const result = repo.createRoom(playerName);
        set.status = 201;
        return result;
      },
      {
        body: t.Object({
          playerName: t.String({ minLength: 1, maxLength: 30 }),
          playerType: t.Optional(t.Union([t.Literal("human"), t.Literal("ai")]))
        })
      }
    )
    .post(
      "/rooms/:code/join",
      ({ params, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const playerName = body.playerName.trim();

        if (!playerName) {
          set.status = 400;
          return { error: "Player name cannot be empty" };
        }

        if (gameService.isRoomStarting(code)) {
          set.status = 409;
          return { error: "Cannot join room: game is already starting or in progress" };
        }

        if (body.playerType === "ai") {
          throw new DomainError(403, "AI players must be managed by a human host");
        }
        const joinResult = repo.joinRoom(code, playerName, "human");

        if (joinResult.status === "not_found") {
          set.status = 404;
          return { error: "Room not found" };
        }

        if (joinResult.status === "game_already_started") {
          set.status = 409;
          return { error: "Cannot join room: game is already in progress or completed" };
        }

        const { room, player, sessionToken } = joinResult;

        const players = repo.getPlayers(room.id);
        const lobbyState: LobbyState = {
          room,
          players
        };

        app.server?.publish(
          `room:${room.code}`,
          JSON.stringify({
            type: "lobby_update",
            data: lobbyState
          })
        );

        set.status = 200;
        return { room, player, sessionToken };
      },
      {
        params: t.Object({
          code: t.String({ minLength: 1, maxLength: 10 })
        }),
        body: t.Object({
          playerName: t.String({ minLength: 1, maxLength: 30 }),
          playerType: t.Optional(t.Union([t.Literal("human"), t.Literal("ai")]))
        })
      }
    )
    .get(
      "/rooms/:code",
      ({ params, set }) => {
        const code = params.code.trim().toUpperCase();
        const room = repo.getRoomByCode(code);
        if (!room) {
          set.status = 404;
          return { error: "Room not found" };
        }

        const players = repo.getPlayers(room.id);
        const lobbyState: LobbyState = {
          room,
          players
        };
        return lobbyState;
      },
      {
        params: t.Object({
          code: t.String({ minLength: 1, maxLength: 10 })
        })
      }
    )
    .post(
      "/rooms/:code/start",
      async ({ params, headers, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);

        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const { game, playerStates } = await gameService.startGame(code, auth.player.id);
        const turnDetails = turnRepo.getActiveTurn(game.id);

        for (const ps of playerStates) {
          const playerView = serializeGameForViewer(game, playerStates, ps.playerId, turnDetails);
          app.server?.publish(
            `player:${ps.playerId}`,
            JSON.stringify({
              type: "game_started",
              data: playerView
            })
          );
        }

        aiRunner.reconcile(game.id);
        set.status = 200;
        return { success: true, gameId: game.id };
      },
      {
        params: t.Object({
          code: t.String({ minLength: 1, maxLength: 10 })
        })
      }
    )
    .get(
      "/rooms/:code/game",
      ({ params, headers, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);

        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const gameView = gameService.getGameViewForPlayer(code, auth.player.id);
        if (!gameView) {
          throw new DomainError(404, "Game not found or not started");
        }

        set.status = 200;
        return gameView;
      },
      {
        params: t.Object({
          code: t.String({ minLength: 1, maxLength: 10 })
        })
      }
    )
    .post(
      "/rooms/:code/game/question",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const expectedTurnId = body.expectedTurnId?.trim();
        if (!expectedTurnId) {
          throw new DomainError(400, "expectedTurnId is required");
        }

        const questionText = body.question?.trim();
        if (!questionText || questionText.length > 200) {
          throw new DomainError(400, "Question must be between 1 and 200 characters");
        }

        await gameService.askQuestion(code, auth.player.id, expectedTurnId, questionText);
        const questionId = gameService.getQuestionId(code, expectedTurnId);
        stateChanged(code);
        scheduleEvaluation(code, questionId);

        const updatedView = gameService.getGameViewForPlayer(code, auth.player.id);
        set.status = 200;
        return updatedView;
      },
      {
        params: t.Object({ code: t.String() }),
        body: t.Object({
          expectedTurnId: t.String({ minLength: 1 }),
          question: t.String({ minLength: 1, maxLength: 200 })
        })
      }
    )
    .post(
      "/rooms/:code/game/answer",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const expectedTurnId = body.expectedTurnId?.trim();
        if (!expectedTurnId) {
          throw new DomainError(400, "expectedTurnId is required");
        }

        await gameService.submitAnswer(code, auth.player.id, expectedTurnId, body.answer as AnswerValue);
        stateChanged(code);

        const updatedView = gameService.getGameViewForPlayer(code, auth.player.id);
        set.status = 200;
        return updatedView;
      },
      {
        params: t.Object({ code: t.String() }),
        body: t.Object({
          expectedTurnId: t.String({ minLength: 1 }),
          answer: t.Union([t.Literal("yes"), t.Literal("no"), t.Literal("maybe")])
        })
      }
    )
    .post(
      "/rooms/:code/game/close-answers",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const expectedTurnId = body.expectedTurnId?.trim();
        if (!expectedTurnId) {
          throw new DomainError(400, "expectedTurnId is required");
        }

        await gameService.closeAnswers(code, auth.player.id, expectedTurnId);
        stateChanged(code);

        const updatedView = gameService.getGameViewForPlayer(code, auth.player.id);
        set.status = 200;
        return updatedView;
      },
      {
        params: t.Object({ code: t.String() }),
        body: t.Object({
          expectedTurnId: t.String({ minLength: 1 })
        })
      }
    )
    .post(
      "/rooms/:code/game/guess",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const expectedTurnId = body.expectedTurnId?.trim();
        if (!expectedTurnId) {
          throw new DomainError(400, "expectedTurnId is required");
        }

        const guessText = body.characterName?.trim();
        if (!guessText || guessText.length > 100) {
          throw new DomainError(400, "Guess must be between 1 and 100 characters");
        }

        const result = await gameService.submitGuess(code, auth.player.id, expectedTurnId, guessText);
        stateChanged(code, result.isFinished);

        const updatedView = gameService.getGameViewForPlayer(code, auth.player.id)!;
        set.status = 200;
        return {
          correct: result.correct,
          game: updatedView
        };
      },
      {
        params: t.Object({ code: t.String() }),
        body: t.Object({
          expectedTurnId: t.String({ minLength: 1 }),
          characterName: t.String({ minLength: 1, maxLength: 100 })
        })
      }
    )
    .post(
      "/rooms/:code/game/hints",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) throw new DomainError(401, "Missing or invalid authorization header");
        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) throw new DomainError(401, "Unauthorized session token");
        const expectedTurnId = body.expectedTurnId.trim();
        if (!expectedTurnId) throw new DomainError(400, "expectedTurnId is required");
        const hint = await gameService.purchaseHint(code, auth.player.id, expectedTurnId, body.type);
        stateChanged(code);
        set.status = 200;
        return { hint, game: gameService.getGameViewForPlayer(code, auth.player.id)! };
      },
      {
        params: t.Object({ code: t.String() }),
        body: t.Object({
          expectedTurnId: t.String({ minLength: 1 }),
          type: t.Union([t.Literal("basic"), t.Literal("series"), t.Literal("candidates")])
        })
      }
    )
    .post(
      "/rooms/:code/game/pass",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const expectedTurnId = body.expectedTurnId?.trim();
        if (!expectedTurnId) {
          throw new DomainError(400, "expectedTurnId is required");
        }

        await gameService.passTurn(code, auth.player.id, expectedTurnId);
        stateChanged(code);

        const updatedView = gameService.getGameViewForPlayer(code, auth.player.id);
        set.status = 200;
        return updatedView;
      },
      {
        params: t.Object({ code: t.String() }),
        body: t.Object({
          expectedTurnId: t.String({ minLength: 1 })
        })
      }
    )
    .post(
      "/rooms/:code/game/skip-ai-turn",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) {
          throw new DomainError(401, "Missing or invalid authorization header");
        }

        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) {
          throw new DomainError(401, "Unauthorized session token");
        }

        const expectedTurnId = body.expectedTurnId?.trim();
        if (!expectedTurnId) {
          throw new DomainError(400, "expectedTurnId is required");
        }

        await gameService.skipAiTurn(code, auth.player.id, expectedTurnId);
        stateChanged(code);

        const updatedView = gameService.getGameViewForPlayer(code, auth.player.id);
        set.status = 200;
        return updatedView;
      },
      {
        params: t.Object({ code: t.String() }),
        body: t.Object({
          expectedTurnId: t.String({ minLength: 1 })
        })
      }
    )
    .post(
      "/rooms/:code/ai-players",
      ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) throw new DomainError(401, "Missing or invalid authorization header");
        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) throw new DomainError(401, "Unauthorized session token");
        if (!auth.player.isHost || auth.player.type !== "human") throw new DomainError(403, "Only the human host can manage AI players");
        if (gameService.isRoomStarting(code)) throw new DomainError(409, "Cannot modify AI players while game is starting");
        const players = repo.addAIPlayers(auth.room.id, body.players.map((player) => player.name));
        const lobbyState: LobbyState = { room: auth.room, players: repo.getPlayers(auth.room.id) };
        app.server?.publish(`room:${code}`, JSON.stringify({ type: "lobby_update", data: lobbyState }));
        set.status = 201;
        return { players };
      },
      { params: t.Object({ code: t.String() }), body: t.Object({ players: t.Array(t.Object({ name: t.Union([t.String({ maxLength: 30 }), t.Null()]) }), { minItems: 1, maxItems: 8 }) }) }
    )
    .delete(
      "/rooms/:code/ai-players/:playerId",
      ({ params, headers, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) throw new DomainError(401, "Missing or invalid authorization header");
        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) throw new DomainError(401, "Unauthorized session token");
        if (!auth.player.isHost || auth.player.type !== "human") throw new DomainError(403, "Only the human host can manage AI players");
        if (gameService.isRoomStarting(code)) throw new DomainError(409, "Cannot modify AI players while game is starting");
        repo.removeAIPlayer(auth.room.id, params.playerId);
        const lobbyState: LobbyState = { room: auth.room, players: repo.getPlayers(auth.room.id) };
        app.server?.publish(`room:${code}`, JSON.stringify({ type: "lobby_update", data: lobbyState }));
        set.status = 204;
      },
      { params: t.Object({ code: t.String(), playerId: t.String() }) }
    )
    .post(
      "/rooms/:code/game/moderator/retry",
      async ({ params, headers, body, set }) => {
        const code = params.code.trim().toUpperCase();
        const token = parseBearerToken(headers);
        if (!token) throw new DomainError(401, "Missing or invalid authorization header");
        const auth = repo.authenticatePlayer(token);
        if (!auth || auth.room.code !== code) throw new DomainError(401, "Unauthorized session token");
        await gameService.retryModerator(code, auth.player.id, body.expectedTurnId.trim());
        stateChanged(code);
        set.status = 200;
        return gameService.getGameViewForPlayer(code, auth.player.id);
      },
      { params: t.Object({ code: t.String() }), body: t.Object({ expectedTurnId: t.String({ minLength: 1 }) }) }
    )
    .derive({ as: "scoped" }, ({ query }) => {
      const token = typeof query?.token === "string" ? query.token : undefined;
      const auth = token ? repo.authenticatePlayer(token) : null;
      return {
        sessionAuth: auth
      };
    })
    .ws("/ws", {
      query: t.Object({
        token: t.String({ minLength: 10 })
      }),
      open(ws) {
        const auth = ws.data.sessionAuth;

        if (!auth) {
          ws.send(JSON.stringify({ type: "error", error: "Unauthorized session token" }));
          ws.close();
          return;
        }

        const roomTopic = `room:${auth.room.code}`;
        const playerTopic = `player:${auth.player.id}`;

        ws.subscribe(roomTopic);
        ws.subscribe(playerTopic);

        const { isFirst } = presence.addConnection(auth.player.id);
        if (isFirst) {
          repo.setPlayerConnected(auth.player.id, true);
        }

        // Lobby state update
        const players = repo.getPlayers(auth.room.id);
        const lobbyState: LobbyState = {
          room: auth.room,
          players
        };

        if (isFirst) {
          app.server?.publish(
            roomTopic,
            JSON.stringify({
              type: "lobby_update",
              data: lobbyState
            })
          );
        }

        // Send current lobby state directly to connecting socket
        ws.send(
          JSON.stringify({
            type: "lobby_update",
            data: lobbyState
          })
        );

        // If a game is active for this room, send current sanitized game view to connecting socket
        const gameView = gameService.getGameViewForPlayer(auth.room.code, auth.player.id);
        if (gameView) {
          ws.send(
            JSON.stringify({
              type: gameView.status === "finished" ? "game_finished" : "game_started",
              data: gameView
            })
          );
        }
      },
      close(ws) {
        const auth = ws.data.sessionAuth;
        if (!auth) return;

        const { isLast } = presence.removeConnection(auth.player.id);
        if (isLast) {
          repo.setPlayerConnected(auth.player.id, false);

          const players = repo.getPlayers(auth.room.id);
          const room = repo.getRoomByCode(auth.room.code);
          if (room) {
            const lobbyState: LobbyState = {
              room,
              players
            };

            app.server?.publish(
              `room:${auth.room.code}`,
              JSON.stringify({
                type: "lobby_update",
                data: lobbyState
              })
            );
          }
        }
      }
    });

  queueMicrotask(() => {
    for (const pending of turnRepo.listRecoverableModeratorQuestions(aiConfig.moderatorRetries + 1)) scheduleEvaluation(pending.roomCode, pending.questionId);
    aiRunner.reconcileAll();
  });

  async function awaitAI() { await awaitEvaluations(); await aiRunner.drain(); }
  return { app, repo, db, presence, gameRepo, turnRepo, gameService, economyRepo, hintService, aiRunner, awaitEvaluations, awaitAI };
}
