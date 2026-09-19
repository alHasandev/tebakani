import type { CharacterSource, GameView, AnswerValue } from "@tebakani/shared";
import type { RoomRepository } from "./repository";
import type { GameRepository, PlayerGameStateEntity, GameEntity } from "./game-repository";
import type { TurnRepository } from "./turn-repository";
import { serializeGameForViewer } from "./game-serializer";
import { DomainError } from "./errors";
import type { AIModerator } from "./ai-moderator";
import { EconomyRepository, HintService } from "./economy";
import type { HintType, PurchasedHint } from "@tebakani/shared";
import type { GameActor } from "./ai-player-types";
import type { AIActivityRepository } from "./ai-activity";
import { uniqueCharacters } from "./character-identity";

export class GameService {
  private startingRoomIds = new Set<string>();

  constructor(
    private roomRepo: RoomRepository,
    private gameRepo: GameRepository,
    private turnRepo: TurnRepository,
    private characterSource: CharacterSource,
    private moderator: AIModerator,
    private economy: EconomyRepository,
    private hints: HintService,
    private activity?: AIActivityRepository
  ) {}

  isRoomStarting(roomIdOrCode: string): boolean {
    if (this.startingRoomIds.has(roomIdOrCode)) {
      return true;
    }
    const room = this.roomRepo.getRoomByCode(roomIdOrCode);
    if (room && this.startingRoomIds.has(room.id)) {
      return true;
    }
    return false;
  }

  async startGame(
    code: string,
    requesterPlayerId: string
  ): Promise<{
    game: GameEntity;
    playerStates: PlayerGameStateEntity[];
  }> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) {
      throw new DomainError(404, "Room not found");
    }

    if (this.startingRoomIds.has(room.id)) {
      throw new DomainError(409, "Game has already been started or is starting");
    }

    const existingGame = this.gameRepo.getGameByRoomId(room.id);
    if (existingGame) {
      throw new DomainError(409, "Game has already been started");
    }

    const players = this.roomRepo.getPlayers(room.id);
    const requester = players.find((p) => p.id === requesterPlayerId);
    if (!requester || !requester.isHost) {
      throw new DomainError(403, "Only the host can start the game");
    }

    if (players.length < 2) {
      throw new DomainError(400, "At least 2 players are required to start");
    }

    this.startingRoomIds.add(room.id);

    try {
      const shuffledPlayers = [...players];
      for (let i = shuffledPlayers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledPlayers[i], shuffledPlayers[j]] = [shuffledPlayers[j], shuffledPlayers[i]];
      }

      let characters;
      try {
        characters = uniqueCharacters(await this.characterSource.getRandomCharacters(shuffledPlayers.length));
      } catch {
        throw new DomainError(400, "Not enough unique characters available to start game");
      }

      if (!Array.isArray(characters) || characters.length < shuffledPlayers.length) {
        throw new DomainError(400, "Not enough unique characters available to start game");
      }

      const charIds = new Set(characters.map((c) => c.id));
      if (charIds.size < shuffledPlayers.length) {
        throw new DomainError(400, "Not enough unique characters available to start game");
      }

      const assignments = shuffledPlayers.map((player, idx) => ({
        playerId: player.id,
        character: characters[idx],
        turnOrder: idx
      }));

      try {
        const game = this.gameRepo.createGameWithAssignments(room.id, assignments);
        const playerStates = this.gameRepo.getPlayerGameStates(game.id);
        return { game, playerStates };
      } catch (err: any) {
        if (err?.message?.includes("UNIQUE constraint failed: games.room_id")) {
          throw new DomainError(409, "Game has already been started");
        }
        throw err;
      }
    } finally {
      this.startingRoomIds.delete(room.id);
    }
  }

  getGameViewForPlayer(code: string, viewerPlayerId: string): GameView | null {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) return null;

    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) return null;

    const playerStates = this.gameRepo.getPlayerGameStates(game.id);
    const isMember = playerStates.some((p) => p.playerId === viewerPlayerId);
    if (!isMember) {
      return null;
    }

    const turnDetails = this.turnRepo.getActiveTurn(game.id);
    return serializeGameForViewer(
      game,
      playerStates,
      viewerPlayerId,
      turnDetails,
      this.economy.getLedger(game.id, viewerPlayerId),
      this.economy.getHints(game.id, viewerPlayerId),
      this.activity?.get(game.id, turnDetails?.turn.id ?? null).activity ?? [],
      this.activity?.get(game.id, turnDetails?.turn.id ?? null).lastAction ?? null
    );
  }

  // --- Milestone 3 Turn Actions (Atomic in SQLite with expectedTurnId) ---

  async askQuestion(
    code: string,
    requesterPlayerId: string,
    expectedTurnId: string,
    questionText: string
  ): Promise<GameEntity> {
    const trimmed = questionText.trim();
    if (!trimmed || trimmed.length > 200) {
      throw new DomainError(400, "Question must be between 1 and 200 characters");
    }

    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");

    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");

    this.turnRepo.askQuestionAtomic(game.id, requesterPlayerId, expectedTurnId, trimmed);
    return this.gameRepo.getGameByRoomId(room.id)!;
  }

  async askQuestionAsAI(code: string, actor: GameActor & { kind: "ai" }, expectedTurnId: string, questionText: string): Promise<GameEntity> {
    const trimmed = questionText.trim();
    if (!trimmed || trimmed.length > 200) throw new DomainError(400, "Question must be between 1 and 200 characters");
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    this.turnRepo.askQuestionAtomic(game.id, actor.playerId, expectedTurnId, trimmed, actor);
    return this.gameRepo.getGameByRoomId(room.id)!;
  }

  async evaluateQuestion(questionId: string, maximumAttempts?: number, isStopped: () => boolean = () => false): Promise<boolean> {
    if (isStopped()) return false;
    const job = this.turnRepo.claimModeratorJob(questionId, false, maximumAttempts);
    if (!job) return false;
    try {
      const answer = await this.moderator.moderate({ question: job.question, character: job.character });
      if (isStopped()) return false;
      return this.turnRepo.completeModeratorJob(job.questionId, job.claimToken, answer);
    } catch {
      if (!isStopped()) this.turnRepo.failModeratorJob(job.questionId, job.claimToken);
      return false;
    }
  }

  async retryModerator(code: string, requesterPlayerId: string, expectedTurnId: string): Promise<string> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    const questionId = this.turnRepo.retryModeratorAtomic(game.id, requesterPlayerId, expectedTurnId);
    const job = this.turnRepo.claimModeratorJob(questionId, true);
    if (!job) throw new DomainError(409, "Moderator retry was claimed concurrently");
    try {
      const answer = await this.moderator.moderate({ question: job.question, character: job.character });
      this.turnRepo.completeModeratorJob(job.questionId, job.claimToken, answer);
    } catch {
      this.turnRepo.failModeratorJob(job.questionId, job.claimToken);
    }
    return questionId;
  }

  getQuestionId(code: string, expectedTurnId: string): string {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    return this.turnRepo.getQuestionIdForTurn(game.id, expectedTurnId);
  }

  async submitAnswer(
    code: string,
    requesterPlayerId: string,
    expectedTurnId: string,
    answer: AnswerValue
  ): Promise<GameEntity> {
    const validAnswers: AnswerValue[] = ["yes", "no", "maybe"];
    if (!validAnswers.includes(answer)) {
      throw new DomainError(400, "Answer must be yes, no, or maybe");
    }

    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");

    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");

    this.turnRepo.submitAnswerAtomic(game.id, requesterPlayerId, expectedTurnId, answer);
    return this.gameRepo.getGameByRoomId(room.id)!;
  }

  async submitAnswerAsAI(code: string, actor: GameActor & { kind: "ai" }, expectedTurnId: string, answer: AnswerValue): Promise<GameEntity> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    this.turnRepo.submitAnswerAtomic(game.id, actor.playerId, expectedTurnId, answer, actor);
    return this.gameRepo.getGameByRoomId(room.id)!;
  }

  async closeAnswers(code: string, requesterPlayerId: string, expectedTurnId: string): Promise<GameEntity> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");

    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");

    const activeTurn = this.turnRepo.getActiveTurn(game.id);
    if (!activeTurn || activeTurn.turn.id !== expectedTurnId || activeTurn.turn.activePlayerId !== requesterPlayerId) {
      throw new DomainError(403, "Only the active player can close answers");
    }
    this.economy.settleTurn(game.id, expectedTurnId);
    return this.gameRepo.getGameByRoomId(room.id)!;
  }

  async submitGuess(
    code: string,
    requesterPlayerId: string,
    expectedTurnId: string,
    characterName: string
  ): Promise<{ correct: boolean; game: GameEntity; isFinished: boolean }> {
    const trimmedGuess = characterName.trim();
    if (!trimmedGuess || trimmedGuess.length > 100) {
      throw new DomainError(400, "Guess must be between 1 and 100 characters");
    }

    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");

    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");

    const { correct, isFinished } = this.turnRepo.submitGuessAtomic(
      game.id,
      requesterPlayerId,
      expectedTurnId,
      trimmedGuess
    );
    const updatedGame = this.gameRepo.getGameByRoomId(room.id)!;
    return { correct, game: updatedGame, isFinished };
  }

  async passTurn(code: string, requesterPlayerId: string, expectedTurnId: string): Promise<GameEntity> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");

    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");

    this.turnRepo.passTurnAtomic(game.id, requesterPlayerId, expectedTurnId);
    return this.gameRepo.getGameByRoomId(room.id)!;
  }

  async purchaseHint(code: string, requesterPlayerId: string, expectedTurnId: string, hintType: HintType): Promise<PurchasedHint> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game || game.status !== "playing") throw new DomainError(409, "Game is not in playing status");
    const state = this.gameRepo.getPlayerGameStates(game.id).find((entry) => entry.playerId === requesterPlayerId);
    if (!state || state.playerType !== "human") throw new DomainError(403, "Only human game players can purchase hints");
    return this.hints.purchase(game.id, requesterPlayerId, expectedTurnId, hintType, state.character);
  }

  async closeAnswersAsAI(code: string, actor: GameActor & { kind: "ai" }, expectedTurnId: string, collectionDelayMs: number, nowMs: number): Promise<GameEntity> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    const state = this.gameRepo.getPlayerGameStates(game.id).find((entry) => entry.playerId === actor.playerId);
    if (!state || state.playerType !== "ai") throw new DomainError(403, "Trusted AI actor is not an AI player in this game");
    this.economy.settleTurn(game.id, expectedTurnId, { playerId: actor.playerId, collectionDelayMs, nowMs });
    return this.gameRepo.getGameByRoomId(room.id)!;
  }

  async submitGuessAsAI(code: string, actor: GameActor & { kind: "ai" }, expectedTurnId: string, characterName: string) {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    const state = this.gameRepo.getPlayerGameStates(game.id).find((entry) => entry.playerId === actor.playerId);
    if (!state || state.playerType !== "ai") throw new DomainError(403, "Trusted AI actor is not an AI player in this game");
    return this.turnRepo.submitGuessAtomic(game.id, actor.playerId, expectedTurnId, characterName.trim());
  }

  async passTurnAsAI(code: string, actor: GameActor & { kind: "ai" }, expectedTurnId: string): Promise<void> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    const state = this.gameRepo.getPlayerGameStates(game.id).find((entry) => entry.playerId === actor.playerId);
    if (!state || state.playerType !== "ai") throw new DomainError(403, "Trusted AI actor is not an AI player in this game");
    this.turnRepo.passTurnAtomic(game.id, actor.playerId, expectedTurnId);
  }

  async purchaseHintAsAI(code: string, actor: GameActor & { kind: "ai" }, expectedTurnId: string, hintType: HintType): Promise<PurchasedHint> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");
    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");
    const state = this.gameRepo.getPlayerGameStates(game.id).find((entry) => entry.playerId === actor.playerId);
    if (!state || state.playerType !== "ai") throw new DomainError(403, "Trusted AI actor is not an AI player in this game");
    return this.hints.purchase(game.id, actor.playerId, expectedTurnId, hintType, state.character, "ai");
  }

  async skipAiTurn(code: string, requesterPlayerId: string, expectedTurnId: string): Promise<GameEntity> {
    const room = this.roomRepo.getRoomByCode(code);
    if (!room) throw new DomainError(404, "Room not found");

    const game = this.gameRepo.getGameByRoomId(room.id);
    if (!game) throw new DomainError(404, "Game not found");

    this.turnRepo.skipAiTurnAtomic(game.id, requesterPlayerId, expectedTurnId);
    return this.gameRepo.getGameByRoomId(room.id)!;
  }
}
