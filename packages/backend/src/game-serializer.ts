import type { GameView, GamePlayerStateView, CurrentTurnView, PointLedgerEntry, PurchasedHint, AIActivityView, AIActionView } from "@tebakani/shared";
import type { GameEntity, PlayerGameStateEntity } from "./game-repository";
import type { FullTurnDetails } from "./turn-repository";

export function serializeGameForViewer(
  game: GameEntity,
  playerStates: PlayerGameStateEntity[],
  viewerPlayerId: string,
  turnDetails: FullTurnDetails | null,
  ownLedger: PointLedgerEntry[] = [],
  ownHints: PurchasedHint[] = [],
  aiActivity: AIActivityView[] = [],
  lastAIAction: AIActionView | null = null,
  historyDetails: FullTurnDetails[] = []
): GameView {
  const players: GamePlayerStateView[] = playerStates.map((ps) => {
    const isSelf = ps.playerId === viewerPlayerId;
    const isCurrentTurn = ps.playerId === game.currentTurnPlayerId;

    const base: GamePlayerStateView = {
      playerId: ps.playerId,
      playerName: ps.playerName,
      playerType: ps.playerType,
      turnOrder: ps.turnOrder,
      isCurrentTurn,
      connected: ps.connected,
      hasGuessedCorrectly: ps.hasGuessedCorrectly,
      completedAt: ps.completedAt,
      pointBalance: ps.pointBalance
    };

    // Strict secrecy rule:
    // If not self, character metadata is always visible.
    // If self, character metadata is completely omitted UNTIL hasGuessedCorrectly is true.
    if (!isSelf || ps.hasGuessedCorrectly) {
      base.character = {
        id: ps.character.id,
        name: ps.character.name,
        series: ps.character.series,
        imageUrl: ps.character.imageUrl,
        description: ps.character.description
      };
    }

    return base;
  });

  let currentTurn: CurrentTurnView | null = null;
  if (turnDetails && game.status === "playing") {
    currentTurn = {
      id: turnDetails.turn.id,
      gameId: turnDetails.turn.gameId,
      turnNumber: turnDetails.turn.turnNumber,
      activePlayerId: turnDetails.turn.activePlayerId,
      activePlayerName: turnDetails.turn.activePlayerName,
      activePlayerType: turnDetails.turn.activePlayerType,
      phase: turnDetails.turn.phase,
      question: turnDetails.question
        ? {
            id: turnDetails.question.id,
            questionText: turnDetails.question.questionText,
            askedAt: turnDetails.question.askedAt,
            moderatorStatus: turnDetails.question.moderatorStatus,
            moderatorAnswer: turnDetails.turn.phase === "collecting_answers" ? null : turnDetails.question.moderatorAnswer,
            moderatorRevision: turnDetails.question.moderatorRevision,
            answerDeadlineAt: turnDetails.question.answerDeadlineAt,
            eligibleAnswererCount: turnDetails.question.eligibleAnswererCount,
            answeredCount: turnDetails.question.answeredCount,
            answers: turnDetails.answers.map((a) => ({
              playerId: a.answeringPlayerId,
              playerName: a.answeringPlayerName,
              answer: a.answer,
              answeredAt: a.answeredAt
            })),
            awards: turnDetails.awards
          }
        : null,
      startedAt: turnDetails.turn.startedAt
    };
  }

  return {
    id: game.id,
    roomId: game.roomId,
    roomCode: game.roomCode,
    status: game.status,
    revision: game.revision,
    serverTime: new Date().toISOString(),
    currentTurnPlayerId: game.currentTurnPlayerId,
    currentTurn,
    answerDurationSeconds: game.answerDurationSeconds,
    history: historyDetails.map((details) => ({
      turnId: details.turn.id,
      turnNumber: details.turn.turnNumber,
      activePlayerId: details.turn.activePlayerId,
      activePlayerName: details.turn.activePlayerName,
      activePlayerType: details.turn.activePlayerType,
      question: details.question ? {
        id: details.question.id,
        questionText: details.question.questionText,
        askedAt: details.question.askedAt,
        answerDeadlineAt: details.question.answerDeadlineAt,
        moderatorStatus: details.question.moderatorStatus,
        moderatorAnswer: details.question.moderatorAnswer,
        moderatorRevision: details.question.moderatorRevision,
        eligibleAnswererCount: details.question.eligibleAnswererCount,
        answeredCount: details.question.answeredCount,
        answers: details.answers.map((answer) => ({ playerId: answer.answeringPlayerId, playerName: answer.answeringPlayerName, answer: answer.answer, answeredAt: answer.answeredAt })),
        awards: details.awards
      } : null,
      outcome: details.turn.outcome ?? (details.turn.endedAt ? "unknown" : null),
      guess: details.guess,
      hintPurchases: details.hintPurchases,
      startedAt: details.turn.startedAt,
      endedAt: details.turn.endedAt
    })),
    players,
    ownLedger,
    ownHints,
    aiActivity,
    lastAIAction,
    createdAt: game.createdAt,
    startedAt: game.startedAt,
    finishedAt: game.finishedAt
  };
}
