import { Database } from "bun:sqlite";
import type { AIActionType, AIActionView, AIActivityStatus, AIActivityView } from "@tebakani/shared";

export class AIActivityRepository {
  constructor(private readonly db: Database) {}

  set(gameId: string, playerId: string, turnId: string, activity: AIActivityStatus): void {
    this.db.prepare(`INSERT INTO ai_activity (game_id, player_id, turn_id, activity, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(game_id, player_id) DO UPDATE SET turn_id = excluded.turn_id, activity = excluded.activity, updated_at = excluded.updated_at`).run(gameId, playerId, turnId, activity, new Date().toISOString());
  }

  clear(gameId: string, playerId: string, turnId: string): void {
    this.db.prepare("DELETE FROM ai_activity WHERE game_id = ? AND player_id = ? AND turn_id = ?").run(gameId, playerId, turnId);
  }

  record(gameId: string, playerId: string, turnId: string, action: AIActionType, outcome: AIActionView["outcome"]): void {
    this.db.prepare(`INSERT INTO ai_action_events (game_id, player_id, turn_id, action, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET player_id = excluded.player_id, turn_id = excluded.turn_id, action = excluded.action, outcome = excluded.outcome, created_at = excluded.created_at`).run(gameId, playerId, turnId, action, outcome, new Date().toISOString());
  }

  get(gameId: string, activeTurnId: string | null): { activity: AIActivityView[]; lastAction: AIActionView | null } {
    const activity = activeTurnId ? this.db.prepare("SELECT player_id playerId, turn_id turnId, activity status, updated_at updatedAt FROM ai_activity WHERE game_id = ? AND turn_id = ? ORDER BY player_id").all(gameId, activeTurnId) as AIActivityView[] : [];
    const lastAction = this.db.prepare("SELECT player_id playerId, turn_id turnId, action, outcome, created_at createdAt FROM ai_action_events WHERE game_id = ?").get(gameId) as AIActionView | null;
    return { activity, lastAction };
  }
}
