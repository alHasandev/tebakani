import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { TurnPhase, AnswerValue, PlayerType, ModeratorStatus, CharacterSummary } from "@tebakani/shared";
import { DomainError } from "./errors";
import type { GameActor } from "./ai-player-types";

export interface TurnEntity {
  id: string;
  gameId: string;
  activePlayerId: string;
  activePlayerName: string;
  activePlayerType: PlayerType;
  turnNumber: number;
  phase: TurnPhase;
  isActive: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface QuestionEntity {
  id: string;
  turnId: string;
  askingPlayerId: string;
  questionText: string;
  askedAt: string;
  moderatorStatus: ModeratorStatus;
  moderatorAnswer: AnswerValue | null;
  moderatorRevision: number;
}

export interface ModeratorJob {
  questionId: string;
  question: string;
  character: CharacterSummary;
  claimToken: string;
}

export interface AnswerEntity {
  id: string;
  questionId: string;
  answeringPlayerId: string;
  answeringPlayerName: string;
  answer: AnswerValue;
  answeredAt: string;
}

export interface FullTurnDetails {
  turn: TurnEntity;
  question: QuestionEntity | null;
  answers: AnswerEntity[];
  awards: Array<{ playerId: string; amount: number }>;
}

export class TurnRepository {
  constructor(private db: Database) {}

  listActiveGames(): Array<{ gameId: string }> {
    return this.db.prepare("SELECT id gameId FROM games WHERE status = 'playing'").all() as Array<{ gameId: string }>;
  }

  listMissingAIAnswerers(gameId: string, turnId: string): string[] {
    return (this.db.prepare(`
      SELECT p.id FROM player_game_state pgs JOIN players p ON p.id = pgs.player_id
      JOIN game_turns gt ON gt.game_id = pgs.game_id AND gt.id = ? AND gt.is_active = 1 AND gt.phase = 'collecting_answers'
      JOIN questions q ON q.turn_id = gt.id
      LEFT JOIN turn_answers ta ON ta.question_id = q.id AND ta.answering_player_id = p.id
      WHERE pgs.game_id = ? AND p.type = 'ai' AND p.id != gt.active_player_id AND ta.id IS NULL
    `).all(turnId, gameId) as Array<{ id: string }>).map((row) => row.id);
  }

  getCollectionState(gameId: string, turnId: string): { activePlayerId: string; moderatorStatus: ModeratorStatus; moderatorAttempts: number; askedAt: string; eligibleCount: number; answeredCount: number } | null {
    return this.db.prepare(`
      SELECT gt.active_player_id activePlayerId, q.moderator_status moderatorStatus, q.moderator_attempts moderatorAttempts, q.asked_at askedAt,
             (SELECT COUNT(*) FROM player_game_state WHERE game_id = gt.game_id AND player_id != gt.active_player_id) eligibleCount,
             (SELECT COUNT(*) FROM turn_answers WHERE question_id = q.id) answeredCount
      FROM game_turns gt JOIN questions q ON q.turn_id = gt.id
      WHERE gt.game_id = ? AND gt.id = ? AND gt.is_active = 1 AND gt.phase = 'collecting_answers'
    `).get(gameId, turnId) as any;
  }

  getActiveTurn(gameId: string): FullTurnDetails | null {
    const turnRow = this.db.prepare(`
      SELECT gt.*, p.name as active_player_name, p.type as active_player_type
      FROM game_turns gt
      JOIN players p ON gt.active_player_id = p.id
      WHERE gt.game_id = ? AND gt.is_active = 1
    `).get(gameId) as {
      id: string;
      game_id: string;
      active_player_id: string;
      active_player_name: string;
      active_player_type: string;
      turn_number: number;
      phase: string;
      is_active: number;
      started_at: string;
      ended_at: string | null;
    } | null;

    if (!turnRow) return null;

    const turn: TurnEntity = {
      id: turnRow.id,
      gameId: turnRow.game_id,
      activePlayerId: turnRow.active_player_id,
      activePlayerName: turnRow.active_player_name,
      activePlayerType: turnRow.active_player_type as PlayerType,
      turnNumber: turnRow.turn_number,
      phase: turnRow.phase as TurnPhase,
      isActive: Boolean(turnRow.is_active),
      startedAt: turnRow.started_at,
      endedAt: turnRow.ended_at
    };

    const questionRow = this.db.prepare(`
      SELECT * FROM questions WHERE turn_id = ?
    `).get(turn.id) as {
      id: string;
      turn_id: string;
      asking_player_id: string;
      question_text: string;
      asked_at: string;
      moderator_status: string;
      moderator_answer: string | null;
      moderator_revision: number;
    } | null;

    if (!questionRow) {
      return { turn, question: null, answers: [], awards: [] };
    }

    const question: QuestionEntity = {
      id: questionRow.id,
      turnId: questionRow.turn_id,
      askingPlayerId: questionRow.asking_player_id,
      questionText: questionRow.question_text,
      askedAt: questionRow.asked_at,
      moderatorStatus: questionRow.moderator_status as ModeratorStatus,
      moderatorAnswer: questionRow.moderator_answer as AnswerValue | null,
      moderatorRevision: questionRow.moderator_revision
    };

    const answerRows = this.db.prepare(`
      SELECT ta.*, p.name as answering_player_name
      FROM turn_answers ta
      JOIN players p ON ta.answering_player_id = p.id
      WHERE ta.question_id = ?
      ORDER BY ta.answered_at ASC
    `).all(question.id) as Array<{
      id: string;
      question_id: string;
      answering_player_id: string;
      answering_player_name: string;
      answer: string;
      answered_at: string;
    }>;

    const answers: AnswerEntity[] = answerRows.map((a) => ({
      id: a.id,
      questionId: a.question_id,
      answeringPlayerId: a.answering_player_id,
      answeringPlayerName: a.answering_player_name,
      answer: a.answer as AnswerValue,
      answeredAt: a.answered_at
    }));

    const awards = this.db.prepare(`
      SELECT player_id playerId, amount FROM point_ledger
      WHERE question_id = ? AND reason = 'answer_match' ORDER BY player_id
    `).all(question.id) as Array<{ playerId: string; amount: number }>;

    return { turn, question, answers, awards };
  }

  askQuestionAtomic(gameId: string, requesterPlayerId: string, expectedTurnId: string, questionText: string, actor: GameActor = { kind: "human", playerId: requesterPlayerId }): void {
    const now = new Date().toISOString();
    const questionId = randomUUID();

    const tx = this.db.transaction(() => {
      const gameRow = this.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string } | null;
      if (!gameRow || gameRow.status !== "playing") {
        throw new DomainError(409, "Game is not in playing status");
      }

      const turn = this.db.prepare(`
        SELECT gt.*, p.type as player_type
        FROM game_turns gt
        JOIN players p ON gt.active_player_id = p.id
        WHERE gt.game_id = ? AND gt.is_active = 1
      `).get(gameId) as { id: string; active_player_id: string; phase: string; player_type: string } | null;

      if (!turn) {
        throw new DomainError(404, "No active turn found for game");
      }

      if (turn.id !== expectedTurnId) {
        throw new DomainError(409, "Stale turn: turn has already advanced");
      }

      if (actor.playerId !== requesterPlayerId || turn.player_type !== actor.kind) {
        throw new DomainError(403, "Actor type does not match the game player");
      }

      if (turn.active_player_id !== requesterPlayerId) {
        throw new DomainError(403, "It is not your turn to ask a question");
      }

      if (turn.phase !== "waiting_for_question") {
        throw new DomainError(409, "Turn is not in waiting_for_question phase or question already asked");
      }

      const playerState = this.db.prepare(`
        SELECT has_guessed_correctly FROM player_game_state WHERE game_id = ? AND player_id = ?
      `).get(gameId, requesterPlayerId) as { has_guessed_correctly: number } | null;

      if (!playerState) {
        throw new DomainError(403, "You are not a player in this game");
      }
      if (playerState.has_guessed_correctly) {
        throw new DomainError(403, "Completed player cannot ask questions");
      }

      const updateResult = this.db.prepare(`
        UPDATE game_turns SET phase = 'collecting_answers' WHERE id = ? AND phase = 'waiting_for_question'
      `).run(turn.id);

      if (updateResult.changes === 0) {
        throw new DomainError(409, "Turn phase was modified concurrently");
      }

      this.db.prepare(`
        INSERT INTO questions (id, turn_id, asking_player_id, question_text, asked_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(questionId, turn.id, requesterPlayerId, questionText, now);
    });

    tx();
  }

  claimModeratorJob(questionId: string, retryFailed = false, maximumAttempts?: number): ModeratorJob | null {
    const claimToken = randomUUID();
    const allowedStatus = retryFailed ? "failed" : "pending";
    const result = this.db.prepare(`
      UPDATE questions
      SET moderator_claim_token = ?, moderator_attempts = moderator_attempts + 1,
          moderator_revision = moderator_revision + 1,
          moderator_status = 'pending', moderator_error = NULL
      WHERE id = ? AND moderator_status = ? AND moderator_claim_token IS NULL
        AND (? IS NULL OR moderator_attempts < ?)
    `).run(claimToken, questionId, allowedStatus, maximumAttempts ?? null, maximumAttempts ?? null);
    if (result.changes === 0) return null;

    const row = this.db.prepare(`
       SELECT q.id, q.question_text, pgs.assigned_character_id, pgs.character_name,
              pgs.character_series, pgs.character_image_url, pgs.character_description, pgs.character_snapshot_json
      FROM questions q
      JOIN game_turns gt ON gt.id = q.turn_id
      JOIN player_game_state pgs ON pgs.game_id = gt.game_id AND pgs.player_id = q.asking_player_id
      WHERE q.id = ? AND q.moderator_claim_token = ?
    `).get(questionId, claimToken) as {
      id: string;
      question_text: string;
      assigned_character_id: string;
      character_name: string;
      character_series: string;
      character_image_url: string | null;
       character_description: string | null;
       character_snapshot_json: string | null;
     } | null;
    if (!row) return null;
    return {
      questionId: row.id,
      question: row.question_text,
      claimToken,
       character: (() => {
         try { return row.character_snapshot_json ? JSON.parse(row.character_snapshot_json) : { id: row.assigned_character_id, name: row.character_name, series: row.character_series, imageUrl: row.character_image_url ?? undefined, description: row.character_description ?? undefined }; }
         catch { return { id: row.assigned_character_id, name: row.character_name, series: row.character_series, imageUrl: row.character_image_url ?? undefined, description: row.character_description ?? undefined }; }
       })()
    };
  }

  completeModeratorJob(questionId: string, claimToken: string, answer: AnswerValue): boolean {
    if (!(["yes", "no", "maybe"] as unknown[]).includes(answer)) return this.failModeratorJob(questionId, claimToken);
    const result = this.db.prepare(`
      UPDATE questions
      SET moderator_status = 'answered', moderator_answer = ?, moderator_error = NULL,
          moderator_claim_token = NULL, moderated_at = ?, moderator_revision = moderator_revision + 1
      WHERE id = ? AND moderator_status = 'pending' AND moderator_claim_token = ?
        AND EXISTS (SELECT 1 FROM game_turns gt WHERE gt.id = questions.turn_id AND gt.is_active = 1 AND gt.phase = 'collecting_answers')
    `).run(answer, new Date().toISOString(), questionId, claimToken);
    return result.changes === 1;
  }

  failModeratorJob(questionId: string, claimToken: string): boolean {
    const result = this.db.prepare(`
      UPDATE questions
      SET moderator_status = 'failed', moderator_answer = NULL,
          moderator_error = 'Moderator evaluation failed', moderator_claim_token = NULL, moderated_at = ?,
          moderator_revision = moderator_revision + 1
      WHERE id = ? AND moderator_status = 'pending' AND moderator_claim_token = ?
        AND EXISTS (SELECT 1 FROM game_turns gt WHERE gt.id = questions.turn_id AND gt.is_active = 1 AND gt.phase = 'collecting_answers')
    `).run(new Date().toISOString(), questionId, claimToken);
    return result.changes === 1;
  }

  listRecoverableModeratorQuestions(maximumAttempts?: number): Array<{ questionId: string; roomCode: string }> {
    return this.db.prepare(`
      SELECT q.id questionId, r.code roomCode
      FROM questions q
      JOIN game_turns gt ON gt.id = q.turn_id
      JOIN games g ON g.id = gt.game_id
      JOIN rooms r ON r.id = g.room_id
      WHERE q.moderator_status = 'pending' AND q.moderator_claim_token IS NULL
        AND gt.is_active = 1 AND gt.phase = 'collecting_answers' AND g.status = 'playing'
        AND (? IS NULL OR q.moderator_attempts < ?)
    `).all(maximumAttempts ?? null, maximumAttempts ?? null) as Array<{ questionId: string; roomCode: string }>;
  }

  getQuestionIdForTurn(gameId: string, expectedTurnId: string): string {
    const row = this.db.prepare(`
      SELECT q.id FROM questions q
      JOIN game_turns gt ON gt.id = q.turn_id
      WHERE gt.game_id = ? AND gt.id = ? AND gt.is_active = 1
    `).get(gameId, expectedTurnId) as { id: string } | null;
    if (!row) throw new DomainError(409, "No active question found for turn");
    return row.id;
  }

  retryModeratorAtomic(gameId: string, requesterPlayerId: string, expectedTurnId: string): string {
    const row = this.db.prepare(`
      SELECT q.id, q.moderator_status, gt.active_player_id, p.is_host
      FROM game_turns gt
      JOIN questions q ON q.turn_id = gt.id
      JOIN players p ON p.id = ?
      WHERE gt.game_id = ? AND gt.id = ? AND gt.is_active = 1
    `).get(requesterPlayerId, gameId, expectedTurnId) as {
      id: string;
      moderator_status: string;
      active_player_id: string;
      is_host: number;
    } | null;
    if (!row) throw new DomainError(409, "No active question found for turn");
    if (!row.is_host && row.active_player_id !== requesterPlayerId) {
      throw new DomainError(403, "Only the host or active human player can retry moderation");
    }
    if (row.moderator_status !== "failed") {
      throw new DomainError(409, "Moderator evaluation is not failed");
    }
    return row.id;
  }

  submitAnswerAtomic(gameId: string, requesterPlayerId: string, expectedTurnId: string, answer: AnswerValue, actor: GameActor = { kind: "human", playerId: requesterPlayerId }): void {
    const now = new Date().toISOString();
    const answerId = randomUUID();

    const tx = this.db.transaction(() => {
      const gameRow = this.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string } | null;
      if (!gameRow || gameRow.status !== "playing") {
        throw new DomainError(409, "Game is not in playing status");
      }

      const playerRow = this.db.prepare(`
        SELECT p.type, pgs.has_guessed_correctly
        FROM players p
        JOIN player_game_state pgs ON p.id = pgs.player_id
        WHERE pgs.game_id = ? AND p.id = ?
      `).get(gameId, requesterPlayerId) as { type: string; has_guessed_correctly: number } | null;

      if (!playerRow) {
        throw new DomainError(403, "You are not a player in this game");
      }

      if (actor.playerId !== requesterPlayerId || playerRow.type !== actor.kind) {
        throw new DomainError(403, "Actor type does not match the game player");
      }

      const turn = this.db.prepare(`
        SELECT gt.id, gt.active_player_id, gt.phase, q.id as question_id
        FROM game_turns gt
        LEFT JOIN questions q ON gt.id = q.turn_id
        WHERE gt.game_id = ? AND gt.is_active = 1
      `).get(gameId) as { id: string; active_player_id: string; phase: string; question_id: string | null } | null;

      if (!turn || !turn.question_id) {
        throw new DomainError(409, "No active question found to answer");
      }

      if (turn.id !== expectedTurnId) {
        throw new DomainError(409, "Stale turn: turn has already advanced");
      }

      if (turn.active_player_id === requesterPlayerId) {
        throw new DomainError(403, "Active turn player cannot answer their own question");
      }

      if (turn.phase !== "collecting_answers") {
        throw new DomainError(409, "Turn is not in collecting_answers phase");
      }

      this.db.prepare(`
        INSERT INTO turn_answers (id, question_id, answering_player_id, answer, answered_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(question_id, answering_player_id) DO UPDATE SET
          answer = excluded.answer,
          answered_at = excluded.answered_at
      `).run(answerId, turn.question_id, requesterPlayerId, answer, now);
    });

    tx();
  }

  closeAnswersAsAIAtomic(gameId: string, actor: GameActor & { kind: "ai" }, expectedTurnId: string, collectionDelayMs: number, nowMs: number): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT gt.active_player_id, gt.phase, p.type player_type, q.id question_id,
               q.moderator_status, q.asked_at,
               (SELECT COUNT(*) FROM player_game_state WHERE game_id = gt.game_id AND player_id != gt.active_player_id) eligible_count,
               (SELECT COUNT(*) FROM turn_answers WHERE question_id = q.id) answered_count
        FROM game_turns gt JOIN players p ON p.id = gt.active_player_id JOIN questions q ON q.turn_id = gt.id
        WHERE gt.game_id = ? AND gt.id = ? AND gt.is_active = 1
      `).get(gameId, expectedTurnId) as any;
      if (!row) throw new DomainError(409, "No active question found for turn");
      if (actor.playerId !== row.active_player_id || row.player_type !== "ai") throw new DomainError(403, "Only the active AI player can close answers");
      if (row.phase !== "collecting_answers" || row.moderator_status !== "answered") throw new DomainError(409, "Turn is not ready for settlement");
      if (row.answered_count < row.eligible_count && nowMs - Date.parse(row.asked_at) < collectionDelayMs) throw new DomainError(409, "Answer collection deadline has not elapsed");
    });
    tx.immediate();
  }

  closeAnswersAtomic(gameId: string, requesterPlayerId: string, expectedTurnId: string): void {
    const tx = this.db.transaction(() => {
      const gameRow = this.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string } | null;
      if (!gameRow || gameRow.status !== "playing") {
        throw new DomainError(409, "Game is not in playing status");
      }

      const turn = this.db.prepare(`
        SELECT gt.id, gt.active_player_id, gt.phase, q.moderator_status
        FROM game_turns gt
        LEFT JOIN questions q ON q.turn_id = gt.id
        WHERE gt.game_id = ? AND gt.is_active = 1
      `).get(gameId) as { id: string; active_player_id: string; phase: string; moderator_status: string | null } | null;

      if (!turn) {
        throw new DomainError(404, "No active turn found");
      }

      if (turn.id !== expectedTurnId) {
        throw new DomainError(409, "Stale turn: turn has already advanced");
      }

      if (turn.active_player_id !== requesterPlayerId) {
        throw new DomainError(403, "Only the active player can close answers");
      }

      if (turn.phase !== "collecting_answers") {
        throw new DomainError(409, "Turn is not in collecting_answers phase");
      }

      if (turn.moderator_status !== "answered") {
        throw new DomainError(409, "Moderator answer must be ready before answers can be closed");
      }

      const result = this.db.prepare(`
        UPDATE game_turns SET phase = 'awaiting_guess' WHERE id = ? AND phase = 'collecting_answers'
      `).run(turn.id);

      if (result.changes === 0) {
        throw new DomainError(409, "Turn phase was modified concurrently");
      }
    });

    tx();
  }

  submitGuessAtomic(
    gameId: string,
    requesterPlayerId: string,
    expectedTurnId: string,
    characterName: string
  ): { correct: boolean; isFinished: boolean } {
    const now = new Date().toISOString();
    let resultOutcome = { correct: false, isFinished: false };

    const tx = this.db.transaction(() => {
      const gameRow = this.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string } | null;
      if (!gameRow || gameRow.status !== "playing") {
        throw new DomainError(409, "Game is not in playing status");
      }

      const turn = this.db.prepare(`
        SELECT id, active_player_id, turn_number, phase
        FROM game_turns WHERE game_id = ? AND is_active = 1
      `).get(gameId) as { id: string; active_player_id: string; turn_number: number; phase: string } | null;

      if (!turn) {
        throw new DomainError(404, "No active turn found");
      }

      if (turn.id !== expectedTurnId) {
        throw new DomainError(409, "Stale turn: turn has already advanced");
      }

      if (turn.phase !== "awaiting_guess") {
        throw new DomainError(409, "Turn is not in awaiting_guess phase");
      }

      if (turn.active_player_id !== requesterPlayerId) {
        throw new DomainError(403, "It is not your turn to make a guess");
      }

      const pgs = this.db.prepare(`
        SELECT character_name, character_snapshot_json, turn_order, has_guessed_correctly
        FROM player_game_state WHERE game_id = ? AND player_id = ?
      `).get(gameId, requesterPlayerId) as { character_name: string; character_snapshot_json: string | null; turn_order: number; has_guessed_correctly: number } | null;

      if (!pgs) {
        throw new DomainError(403, "You are not a player in this game");
      }

      const normalizedGuess = characterName.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
      const normalizedActual = pgs.character_name.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
      let aliases: string[] = [];
      try { aliases = pgs.character_snapshot_json ? JSON.parse(pgs.character_snapshot_json)?.knowledge?.aliases ?? [] : []; } catch {}
      const verifiedNames = [normalizedActual, ...aliases.map((alias) => alias.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " "))];
      const isCorrect = verifiedNames.includes(normalizedGuess);

      try {
        this.db.prepare(`
          INSERT INTO guess_attempts (id, game_id, player_id, turn_id, normalized_guess, display_guess, correct, attempted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), gameId, requesterPlayerId, turn.id, normalizedGuess, characterName.trim(), isCorrect ? 1 : 0, now);
      } catch (error: any) {
        if (error?.message?.includes("UNIQUE constraint failed")) throw new DomainError(409, "Guess has already been attempted");
        throw error;
      }

      const closeTurnResult = this.db.prepare(`
        UPDATE game_turns SET is_active = 0, ended_at = ? WHERE id = ? AND is_active = 1
      `).run(now, turn.id);

      if (closeTurnResult.changes === 0) {
        throw new DomainError(409, "Turn was completed or passed concurrently");
      }

      if (isCorrect) {
        this.db.prepare(`
          UPDATE player_game_state
          SET has_guessed_correctly = 1, completed_at = ?
          WHERE game_id = ? AND player_id = ?
        `).run(now, gameId, requesterPlayerId);
      }

      const allStates = this.db.prepare(`
        SELECT player_id, turn_order, has_guessed_correctly
        FROM player_game_state WHERE game_id = ?
        ORDER BY turn_order ASC
      `).all(gameId) as Array<{ player_id: string; turn_order: number; has_guessed_correctly: number }>;

      const remainingIncomplete = allStates.filter((s) => !s.has_guessed_correctly);

      if (remainingIncomplete.length === 0) {
        this.db.prepare(`
          UPDATE games SET status = 'finished', current_turn_player_id = NULL, finished_at = ? WHERE id = ?
        `).run(now, gameId);
        resultOutcome = { correct: isCorrect, isFinished: true };
        return;
      }

      const nextTurnNumber = turn.turn_number + 1;
      const nextPlayer = this.pickNextIncompletePlayer(allStates, pgs.turn_order);

      this.db.prepare(`
        INSERT INTO game_turns (id, game_id, active_player_id, turn_number, phase, is_active, started_at, ended_at)
        VALUES (?, ?, ?, ?, 'waiting_for_question', 1, ?, NULL)
      `).run(randomUUID(), gameId, nextPlayer.player_id, nextTurnNumber, now);

      this.db.prepare(`
        UPDATE games SET current_turn_player_id = ? WHERE id = ?
      `).run(nextPlayer.player_id, gameId);

      resultOutcome = { correct: isCorrect, isFinished: false };
    });

    tx();
    return resultOutcome;
  }

  passTurnAtomic(gameId: string, requesterPlayerId: string, expectedTurnId: string): void {
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      const gameRow = this.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string } | null;
      if (!gameRow || gameRow.status !== "playing") {
        throw new DomainError(409, "Game is not in playing status");
      }

      const turn = this.db.prepare(`
        SELECT id, active_player_id, turn_number, phase
        FROM game_turns WHERE game_id = ? AND is_active = 1
      `).get(gameId) as { id: string; active_player_id: string; turn_number: number; phase: string } | null;

      if (!turn) {
        throw new DomainError(404, "No active turn found");
      }

      if (turn.id !== expectedTurnId) {
        throw new DomainError(409, "Stale turn: turn has already advanced");
      }

      if (turn.phase !== "collecting_answers" && turn.phase !== "awaiting_guess") {
        throw new DomainError(409, "Turn cannot be passed in its current phase");
      }

      if (turn.active_player_id !== requesterPlayerId) {
        throw new DomainError(403, "It is not your turn to pass");
      }

      const pgs = this.db.prepare(`
        SELECT turn_order FROM player_game_state WHERE game_id = ? AND player_id = ?
      `).get(gameId, requesterPlayerId) as { turn_order: number } | null;

      if (!pgs) {
        throw new DomainError(403, "You are not a player in this game");
      }

      const closeTurnResult = this.db.prepare(`
        UPDATE game_turns SET is_active = 0, ended_at = ? WHERE id = ? AND is_active = 1
      `).run(now, turn.id);

      if (closeTurnResult.changes === 0) {
        throw new DomainError(409, "Turn was completed or passed concurrently");
      }

      const allStates = this.db.prepare(`
        SELECT player_id, turn_order, has_guessed_correctly
        FROM player_game_state WHERE game_id = ?
        ORDER BY turn_order ASC
      `).all(gameId) as Array<{ player_id: string; turn_order: number; has_guessed_correctly: number }>;

      const nextTurnNumber = turn.turn_number + 1;
      const nextPlayer = this.pickNextIncompletePlayer(allStates, pgs.turn_order);

      this.db.prepare(`
        INSERT INTO game_turns (id, game_id, active_player_id, turn_number, phase, is_active, started_at, ended_at)
        VALUES (?, ?, ?, ?, 'waiting_for_question', 1, ?, NULL)
      `).run(randomUUID(), gameId, nextPlayer.player_id, nextTurnNumber, now);

      this.db.prepare(`
        UPDATE games SET current_turn_player_id = ? WHERE id = ?
      `).run(nextPlayer.player_id, gameId);
    });

    tx();
  }

  skipAiTurnAtomic(gameId: string, requesterPlayerId: string, expectedTurnId: string): void {
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      const gameRow = this.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string } | null;
      if (!gameRow || gameRow.status !== "playing") {
        throw new DomainError(409, "Game is not in playing status");
      }

      const hostCheck = this.db.prepare(`
        SELECT is_host FROM players WHERE id = ?
      `).get(requesterPlayerId) as { is_host: number } | null;

      if (!hostCheck || !hostCheck.is_host) {
        throw new DomainError(403, "Only the host can skip AI turns");
      }

      const turn = this.db.prepare(`
        SELECT gt.id, gt.active_player_id, gt.turn_number, p.type as player_type
        FROM game_turns gt
        JOIN players p ON gt.active_player_id = p.id
        WHERE gt.game_id = ? AND gt.is_active = 1
      `).get(gameId) as { id: string; active_player_id: string; turn_number: number; player_type: string } | null;

      if (!turn) {
        throw new DomainError(404, "No active turn found");
      }

      if (turn.id !== expectedTurnId) {
        throw new DomainError(409, "Stale turn: turn has already advanced");
      }

      if (turn.player_type !== "ai") {
        throw new DomainError(409, "The active player is not an AI player");
      }

      const pgs = this.db.prepare(`
        SELECT turn_order FROM player_game_state WHERE game_id = ? AND player_id = ?
      `).get(gameId, turn.active_player_id) as { turn_order: number } | null;

      if (!pgs) {
        throw new DomainError(404, "AI player state not found");
      }

      const closeTurnResult = this.db.prepare(`
        UPDATE game_turns SET is_active = 0, ended_at = ? WHERE id = ? AND is_active = 1
      `).run(now, turn.id);

      if (closeTurnResult.changes === 0) {
        throw new DomainError(409, "Turn was completed or passed concurrently");
      }

      const allStates = this.db.prepare(`
        SELECT player_id, turn_order, has_guessed_correctly
        FROM player_game_state WHERE game_id = ?
        ORDER BY turn_order ASC
      `).all(gameId) as Array<{ player_id: string; turn_order: number; has_guessed_correctly: number }>;

      const nextTurnNumber = turn.turn_number + 1;
      const nextPlayer = this.pickNextIncompletePlayer(allStates, pgs.turn_order);

      this.db.prepare(`
        INSERT INTO game_turns (id, game_id, active_player_id, turn_number, phase, is_active, started_at, ended_at)
        VALUES (?, ?, ?, ?, 'waiting_for_question', 1, ?, NULL)
      `).run(randomUUID(), gameId, nextPlayer.player_id, nextTurnNumber, now);

      this.db.prepare(`
        UPDATE games SET current_turn_player_id = ? WHERE id = ?
      `).run(nextPlayer.player_id, gameId);
    });

    tx();
  }

  private pickNextIncompletePlayer(
    allStates: Array<{ player_id: string; turn_order: number; has_guessed_correctly: number }>,
    currentTurnOrder: number
  ): { player_id: string; turn_order: number; has_guessed_correctly: number } {
    const total = allStates.length;
    for (let step = 1; step <= total; step++) {
      const nextOrder = (currentTurnOrder + step) % total;
      const candidate = allStates.find((s) => s.turn_order === nextOrder);
      if (candidate && !candidate.has_guessed_correctly) {
        return candidate;
      }
    }
    throw new DomainError(409, "No incomplete players remaining");
  }
}
