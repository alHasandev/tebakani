import { Database } from "bun:sqlite";
import { ECONOMY, type AnswerValue, type HintType, type PurchasedHint, type TurnPhase } from "@tebakani/shared";
import { DomainError } from "./errors";
import type { AIPlayerAnswerContext, AIPlayerSelfContext } from "./ai-player-types";

function safeCharacterSnapshot(value: string | null, fallback: { id: string; name: string; series: string; imageUrl?: string; description?: string }) {
  try {
    const parsed = value ? JSON.parse(value) : fallback;
    if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.name !== "string" || !parsed.name || typeof parsed.series !== "string" || !parsed.series) return fallback;
    const { sourceUrl: _, ...rest } = parsed;
    return { id: rest.id, name: rest.name, series: rest.series, imageUrl: rest.imageUrl, description: rest.description, knowledge: rest.knowledge };
  } catch { return fallback; }
}

function parseHints(rows: Array<{ id: string; hint_type: string; hint_value: string; cost: number; purchased_at: string }>): PurchasedHint[] {
  return rows.flatMap((row) => {
    try {
      const value = JSON.parse(row.hint_value);
      if (!["basic", "series", "candidates"].includes(row.hint_type)) return [];
      if (row.hint_type === "candidates" ? !Array.isArray(value) || value.some((item) => typeof item !== "string") : typeof value !== "string") return [];
      return [{ id: row.id, type: row.hint_type as HintType, value, cost: row.cost, purchasedAt: row.purchased_at }];
    } catch {
      return [];
    }
  });
}

export class AIPlayerContextRepository {
  constructor(private readonly db: Database) {}

  buildSelf(gameId: string, playerId: string, expectedTurnId: string): AIPlayerSelfContext {
    const row = this.db.prepare(`
      SELECT p.id player_id, p.name player_name, p.type player_type, pgs.point_balance,
             g.id game_id, r.code room_code, gt.id turn_id, gt.turn_number, gt.phase
      FROM games g JOIN rooms r ON r.id = g.room_id
      JOIN game_turns gt ON gt.game_id = g.id AND gt.is_active = 1
      JOIN player_game_state pgs ON pgs.game_id = g.id AND pgs.player_id = ?
      JOIN players p ON p.id = pgs.player_id
      WHERE g.id = ? AND gt.id = ? AND g.status = 'playing'
    `).get(playerId, gameId, expectedTurnId) as any;
    if (!row || row.player_type !== "ai") throw new DomainError(403, "Trusted AI actor is not an AI player in this game");
    const evidence = this.db.prepare(`
      SELECT q.question_text question, q.moderator_answer moderatorAnswer
      FROM questions q JOIN game_turns gt ON gt.id = q.turn_id
       WHERE gt.game_id = ? AND gt.active_player_id = ? AND q.moderator_status = 'answered'
         AND (gt.is_active = 0 OR gt.phase = 'awaiting_guess')
       ORDER BY gt.turn_number DESC LIMIT 30
    `).all(gameId, playerId) as Array<{ question: string; moderatorAnswer: AnswerValue }>;
    const publicHistory = this.db.prepare(`
      SELECT gt.turn_number turnNumber, p.name activePlayerName, q.question_text question,
             q.moderator_answer moderatorAnswer, gt.outcome
      FROM game_turns gt JOIN players p ON p.id = gt.active_player_id JOIN questions q ON q.turn_id = gt.id
       WHERE gt.game_id = ? AND q.moderator_status = 'answered' AND gt.is_active = 0 AND gt.ended_at IS NOT NULL
       ORDER BY gt.turn_number DESC LIMIT 30
    `).all(gameId) as NonNullable<AIPlayerSelfContext["publicHistory"]>;
    const previousGuesses = this.db.prepare(`
      SELECT display_guess characterName, 0 correct FROM guess_attempts
      WHERE game_id = ? AND player_id = ? AND correct = 0 ORDER BY attempted_at DESC LIMIT 30
    `).all(gameId, playerId) as Array<{ characterName: string; correct: false }>;
    const hints = parseHints(this.db.prepare(`SELECT id, hint_type, hint_value, cost, purchased_at FROM purchased_hints WHERE game_id = ? AND player_id = ? ORDER BY purchased_at`).all(gameId, playerId) as any[]);
    const purchased = new Set(hints.map((hint) => hint.type));
    return {
      player: { id: row.player_id, name: row.player_name, pointBalance: row.point_balance },
      game: { id: row.game_id, roomCode: row.room_code, turnId: row.turn_id, turnNumber: row.turn_number, phase: row.phase as TurnPhase },
      evidence: evidence.reverse(), publicHistory: publicHistory.reverse(), previousGuesses, purchasedHints: hints,
      availableHintTypes: (["basic", "series", "candidates"] as HintType[]).filter((type) => !purchased.has(type) && ECONOMY.hintCosts[type] <= row.point_balance),
      economy: ECONOMY.hintCosts
    };
  }

  buildAnswer(gameId: string, answeringPlayerId: string, expectedTurnId: string): AIPlayerAnswerContext {
    const row = this.db.prepare(`
      SELECT ap.id answering_id, ap.name answering_name, ap.type answering_type,
             gt.id turn_id, gt.active_player_id target_id, tp.name target_name,
             q.id question_id, q.question_text, pgs.assigned_character_id, pgs.character_name,
              pgs.character_series, pgs.character_image_url, pgs.character_description, pgs.character_snapshot_json
      FROM game_turns gt JOIN questions q ON q.turn_id = gt.id
      JOIN players ap ON ap.id = ? JOIN player_game_state aps ON aps.game_id = gt.game_id AND aps.player_id = ap.id
      JOIN players tp ON tp.id = gt.active_player_id
      JOIN player_game_state pgs ON pgs.game_id = gt.game_id AND pgs.player_id = gt.active_player_id
      WHERE gt.game_id = ? AND gt.id = ? AND gt.is_active = 1 AND gt.phase = 'collecting_answers'
    `).get(answeringPlayerId, gameId, expectedTurnId) as any;
    if (!row || row.answering_type !== "ai") throw new DomainError(403, "Trusted AI actor is not an AI player in this game");
    if (row.answering_id === row.target_id) throw new DomainError(403, "AI player cannot answer its own question");
    const publicHistory = this.db.prepare(`
      SELECT gt.turn_number turnNumber, p.name activePlayerName, q.question_text question, q.moderator_answer moderatorAnswer
      FROM game_turns gt JOIN players p ON p.id = gt.active_player_id JOIN questions q ON q.turn_id = gt.id
       WHERE gt.game_id = ? AND q.moderator_status = 'answered' AND gt.id != ?
         AND gt.is_active = 0 AND gt.ended_at IS NOT NULL
       ORDER BY gt.turn_number DESC LIMIT 20
    `).all(gameId, expectedTurnId) as NonNullable<AIPlayerAnswerContext["publicHistory"]>;
    return {
      answeringPlayer: { id: row.answering_id, name: row.answering_name },
      game: { id: gameId, turnId: row.turn_id, questionId: row.question_id }, question: row.question_text,
      publicHistory: publicHistory.reverse(),
      target: { playerId: row.target_id, playerName: row.target_name, character: safeCharacterSnapshot(row.character_snapshot_json, { id: row.assigned_character_id, name: row.character_name, series: row.character_series, imageUrl: row.character_image_url ?? undefined, description: row.character_description ?? undefined }) }
    };
  }

  getUsedQuestionIdentities(gameId: string, playerId: string): string[] {
    const rows = this.db.prepare(`
      SELECT q.question_text
      FROM questions q JOIN game_turns gt ON gt.id = q.turn_id
      WHERE gt.game_id = ? AND gt.active_player_id = ?
      ORDER BY gt.turn_number ASC
      LIMIT 10000
    `).all(gameId, playerId) as Array<{ question_text: string }>;
    return rows.map((row) => row.question_text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim());
  }

  getWrongGuesses(gameId: string, playerId: string): string[] {
    return (this.db.prepare("SELECT normalized_guess FROM guess_attempts WHERE game_id = ? AND player_id = ? AND correct = 0").all(gameId, playerId) as Array<{ normalized_guess: string }>).map((row) => row.normalized_guess);
  }
}
