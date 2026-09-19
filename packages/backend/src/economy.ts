import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { ECONOMY, type CharacterSource, type CharacterSummary, type HintType, type PointLedgerEntry, type PurchasedHint, type TurnPointAwardView } from "@tebakani/shared";
import { DomainError } from "./errors";

export class EconomyRepository {
  constructor(private db: Database) {}

  settleTurn(gameId: string, turnId: string, aiPolicy?: { playerId: string; collectionDelayMs: number; nowMs: number }): TurnPointAwardView[] {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const turn = this.db.prepare(`
        SELECT gt.phase, gt.active_player_id, p.type active_player_type, q.id question_id, q.moderator_status, q.moderator_answer, q.asked_at
        FROM game_turns gt JOIN players p ON p.id = gt.active_player_id JOIN questions q ON q.turn_id = gt.id
        WHERE gt.id = ? AND gt.game_id = ? AND gt.is_active = 1
      `).get(turnId, gameId) as { phase: string; active_player_id: string; active_player_type: string; question_id: string; moderator_status: string; moderator_answer: string | null; asked_at: string } | null;
      if (!turn || turn.phase !== "collecting_answers") throw new DomainError(409, "Turn is not ready for settlement");
      if (turn.moderator_status !== "answered" || !turn.moderator_answer) throw new DomainError(409, "Moderator answer must be ready before answers can be closed");
      if (aiPolicy) {
        if (turn.active_player_type !== "ai" || turn.active_player_id !== aiPolicy.playerId) throw new DomainError(403, "Only the active AI player can close answers");
        const eligible = (this.db.prepare("SELECT COUNT(*) count FROM player_game_state WHERE game_id = ? AND player_id != ?").get(gameId, turn.active_player_id) as { count: number }).count;
        const answered = (this.db.prepare("SELECT COUNT(*) count FROM turn_answers WHERE question_id = ?").get(turn.question_id) as { count: number }).count;
        if (answered < eligible && aiPolicy.nowMs - Date.parse(turn.asked_at) < aiPolicy.collectionDelayMs) throw new DomainError(409, "Answer collection deadline has not elapsed");
      }
      const winners = this.db.prepare(`
        SELECT ta.answering_player_id player_id FROM turn_answers ta
        JOIN player_game_state pgs ON pgs.game_id = ? AND pgs.player_id = ta.answering_player_id
        WHERE ta.question_id = ? AND ta.answer = ? AND ta.answering_player_id != ?
      `).all(gameId, turn.question_id, turn.moderator_answer, turn.active_player_id) as Array<{ player_id: string }>;
      for (const winner of winners) {
        const inserted = this.db.prepare(`
          INSERT OR IGNORE INTO point_ledger (id, game_id, player_id, question_id, hint_purchase_id, amount, reason, created_at)
          VALUES (?, ?, ?, ?, NULL, ?, 'answer_match', ?)
        `).run(randomUUID(), gameId, winner.player_id, turn.question_id, ECONOMY.correctAnswerPoints, now);
        if (inserted.changes === 1) this.db.prepare("UPDATE player_game_state SET point_balance = point_balance + 1 WHERE game_id = ? AND player_id = ?").run(gameId, winner.player_id);
      }
      if (this.db.prepare("UPDATE game_turns SET phase = 'awaiting_guess' WHERE id = ? AND phase = 'collecting_answers'").run(turnId).changes < 1) {
        throw new DomainError(409, "Turn phase was modified concurrently");
      }
      return this.getAwards(turn.question_id);
    });
    return tx.immediate();
  }

  assertHintEligibility(gameId: string, playerId: string, expectedTurnId: string, hintType: HintType, actorKind: "human" | "ai" = "human"): void {
    const state = this.getHintEligibility(gameId, playerId);
    this.validateHintEligibility(state, playerId, expectedTurnId, actorKind);
    if (this.db.prepare("SELECT id FROM purchased_hints WHERE game_id = ? AND player_id = ? AND hint_type = ?").get(gameId, playerId, hintType)) throw new DomainError(409, "Hint has already been purchased");
    if (state.point_balance < ECONOMY.hintCosts[hintType]) throw new DomainError(409, "Insufficient point balance");
  }

  purchaseHint(gameId: string, playerId: string, expectedTurnId: string, hintType: HintType, value: string | string[], actorKind: "human" | "ai" = "human"): PurchasedHint {
    const cost = ECONOMY.hintCosts[hintType];
    const id = randomUUID();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const state = this.getHintEligibility(gameId, playerId);
      this.validateHintEligibility(state, playerId, expectedTurnId, actorKind);
      if (this.db.prepare("SELECT id FROM purchased_hints WHERE game_id = ? AND player_id = ? AND hint_type = ?").get(gameId, playerId, hintType)) throw new DomainError(409, "Hint has already been purchased");
      if (actorKind === "ai" && this.db.prepare("SELECT turn_id FROM ai_turn_hint_purchases WHERE turn_id = ?").get(expectedTurnId)) throw new DomainError(409, "AI may purchase at most one hint per turn");
      if (state.point_balance < cost) throw new DomainError(409, "Insufficient point balance");
      if (this.db.prepare("UPDATE player_game_state SET point_balance = point_balance - ? WHERE game_id = ? AND player_id = ? AND point_balance >= ?").run(cost, gameId, playerId, cost).changes < 1) throw new DomainError(409, "Insufficient point balance");
      this.db.prepare("INSERT INTO purchased_hints (id, game_id, player_id, hint_type, hint_value, cost, purchased_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, gameId, playerId, hintType, JSON.stringify(value), cost, now);
      this.db.prepare("INSERT INTO point_ledger (id, game_id, player_id, question_id, hint_purchase_id, amount, reason, created_at) VALUES (?, ?, ?, NULL, ?, ?, 'hint_purchase', ?)").run(randomUUID(), gameId, playerId, id, -cost, now);
      if (actorKind === "ai") this.db.prepare("INSERT INTO ai_turn_hint_purchases (turn_id, game_id, player_id, hint_purchase_id, created_at) VALUES (?, ?, ?, ?, ?)").run(expectedTurnId, gameId, playerId, id, now);
    });
    tx.immediate();
    return { id, type: hintType, value, cost, purchasedAt: now };
  }

  private getHintEligibility(gameId: string, playerId: string) {
    return this.db.prepare(`
      SELECT g.status, g.current_turn_player_id, p.type, pgs.point_balance, pgs.has_guessed_correctly,
             gt.id turn_id, gt.phase
      FROM games g
      JOIN player_game_state pgs ON pgs.game_id = g.id AND pgs.player_id = ?
      JOIN players p ON p.id = pgs.player_id
      LEFT JOIN game_turns gt ON gt.game_id = g.id AND gt.is_active = 1
      WHERE g.id = ?
    `).get(playerId, gameId) as { status: string; current_turn_player_id: string | null; type: string; point_balance: number; has_guessed_correctly: number; turn_id: string | null; phase: string | null } | null;
  }

  private validateHintEligibility(state: ReturnType<EconomyRepository["getHintEligibility"]>, playerId: string, expectedTurnId: string, actorKind: "human" | "ai"): asserts state is NonNullable<typeof state> {
    if (!expectedTurnId.trim()) throw new DomainError(400, "expectedTurnId is required");
    if (!state || state.type !== actorKind) throw new DomainError(403, "Actor type does not match the game player");
    if (state.status !== "playing") throw new DomainError(409, "Game is not in playing status");
    if (state.has_guessed_correctly) throw new DomainError(403, "Completed player cannot purchase hints");
    if (state.turn_id !== expectedTurnId) throw new DomainError(409, "Stale turn: turn has already advanced");
    if (state.current_turn_player_id !== playerId) throw new DomainError(403, "Only the active player can purchase hints");
    if (state.phase !== "collecting_answers" && state.phase !== "awaiting_guess" && !(actorKind === "ai" && state.phase === "waiting_for_question")) throw new DomainError(409, "Hints cannot be purchased in the current turn phase");
  }

  getAwards(questionId: string): TurnPointAwardView[] {
    return this.db.prepare("SELECT player_id playerId, amount FROM point_ledger WHERE question_id = ? AND reason = 'answer_match' ORDER BY player_id").all(questionId) as TurnPointAwardView[];
  }

  getLedger(gameId: string, playerId: string): PointLedgerEntry[] {
    return (this.db.prepare("SELECT id, question_id, hint_purchase_id, amount, reason, created_at FROM point_ledger WHERE game_id = ? AND player_id = ? ORDER BY created_at, id").all(gameId, playerId) as any[]).map((row) => ({ id: row.id, questionId: row.question_id, hintPurchaseId: row.hint_purchase_id, amount: row.amount, reason: row.reason, createdAt: row.created_at }));
  }

  getHints(gameId: string, playerId: string): PurchasedHint[] {
    const rows = this.db.prepare("SELECT id, hint_type, hint_value, cost, purchased_at FROM purchased_hints WHERE game_id = ? AND player_id = ? ORDER BY purchased_at, id").all(gameId, playerId) as any[];
    return rows.flatMap((row) => {
      try {
        const value = JSON.parse(row.hint_value);
        if (!["basic", "series", "candidates"].includes(row.hint_type)) return [];
        if ((row.hint_type === "candidates" && (!Array.isArray(value) || value.length < 2 || value.length > 10 || value.some((item) => typeof item !== "string"))) || (row.hint_type !== "candidates" && typeof value !== "string")) return [];
        return [{ id: row.id, type: row.hint_type, value, cost: row.cost, purchasedAt: row.purchased_at }];
      } catch { return []; }
    });
  }
}

export class HintService {
  constructor(private source: CharacterSource, private economy: EconomyRepository) {}

  async purchase(gameId: string, playerId: string, expectedTurnId: string, hintType: HintType, character: CharacterSummary, actorKind: "human" | "ai" = "human"): Promise<PurchasedHint> {
    this.economy.assertHintEligibility(gameId, playerId, expectedTurnId, hintType, actorKind);
    const value = await this.createValue(hintType, character);
    return this.economy.purchaseHint(gameId, playerId, expectedTurnId, hintType, value, actorKind);
  }

  private async createValue(hintType: HintType, character: CharacterSummary): Promise<string | string[]> {
    if (hintType === "basic") {
      for (const reference of [character.description, ...(character.knowledge?.notableTraits ?? [])]) {
        if (!reference) continue;
        const clue = this.removeName(reference.normalize("NFKC"), character.name, character.knowledge?.aliases ?? []);
        if (clue) return clue;
      }
      throw new DomainError(409, "Basic hint is unavailable");
    }
    if (hintType === "series") {
      if (!character.series.trim()) throw new DomainError(409, "Series hint is unavailable");
      return character.series.trim();
    }
    let sameSeries: CharacterSummary[] = [];
    let random: CharacterSummary[] = [];
    try {
      if (this.source.getCharactersBySeries) sameSeries = await this.source.getCharactersBySeries(character.series, 10);
      random = await this.getAvailableRandomCharacters();
    } catch { throw new DomainError(409, "Candidate hint is unavailable"); }
    const actualName = character.name.normalize("NFKC").trim().toLocaleLowerCase();
    const seenNames = new Set([actualName]);
    const preferred: CharacterSummary[] = [];
    for (const candidate of [...sameSeries, ...random]) {
      const normalizedName = candidate.name.normalize("NFKC").trim().toLocaleLowerCase();
      if (!normalizedName || seenNames.has(normalizedName) || candidate.id === character.id) continue;
      seenNames.add(normalizedName);
      preferred.push(candidate);
    }
    const candidates = this.shuffle([...preferred.slice(0, 9), character]).map((candidate) => candidate.name);
    if (candidates.length < 2) throw new DomainError(409, "Candidate hint is unavailable");
    return candidates;
  }

  private async getAvailableRandomCharacters(): Promise<CharacterSummary[]> {
    for (let count = 10; count >= 2; count--) {
      try { return await this.source.getRandomCharacters(count); } catch {}
    }
    throw new DomainError(409, "Candidate hint is unavailable");
  }

  private removeName(description: string, name: string, aliases: string[] = []): string {
    const normalizedDescription = description.normalize("NFKC");
    const normalizedName = name.normalize("NFKC");
    const parts = normalizedName.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let clue = normalizedDescription;
    const forbidden = [normalizedName, ...aliases.map((alias) => alias.normalize("NFKC")), ...parts];
    for (const token of forbidden.sort((left, right) => right.length - left.length)) clue = clue.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), "");
    clue = clue.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
    const foldedClue = clue.normalize("NFKC").toLocaleLowerCase();
    const meaningfulTokens = foldedClue.match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length > 2 && !["and", "the", "with", "from"].includes(token)) ?? [];
    if (!clue || meaningfulTokens.length === 0 || parts.some((part) => foldedClue.includes(part.toLocaleLowerCase()))) return "";
    return clue;
  }

  private shuffle<T>(values: T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
      const target = Math.floor(Math.random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }
}
