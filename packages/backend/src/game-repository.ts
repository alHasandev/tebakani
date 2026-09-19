import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { GameStatus, CharacterSummary, PlayerType } from "@tebakani/shared";
import { sanitizeCharacter } from "./character-sanitize";

export interface GameEntity {
  id: string;
  roomId: string;
  roomCode: string;
  status: GameStatus;
  revision: number;
  answerDurationSeconds: number;
  currentTurnPlayerId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PlayerGameStateEntity {
  id: string;
  gameId: string;
  playerId: string;
  playerName: string;
  playerType: PlayerType;
  turnOrder: number;
  connected: boolean;
  hasGuessedCorrectly: boolean;
  completedAt: string | null;
  pointBalance: number;
  character: CharacterSummary;
}

export class GameRepository {
  constructor(private db: Database) {}

  getGameById(gameId: string): GameEntity | null {
    const row = this.db.prepare("SELECT room_id FROM games WHERE id = ?").get(gameId) as { room_id: string } | null;
    return row ? this.getGameByRoomId(row.room_id) : null;
  }

  getGameByRoomId(roomId: string): GameEntity | null {
    const row = this.db.prepare(`
      SELECT g.id, g.room_id, g.status, g.state_revision, g.answer_duration_seconds, g.current_turn_player_id, g.created_at, g.started_at, g.finished_at, r.code as room_code
      FROM games g
      JOIN rooms r ON g.room_id = r.id
      WHERE g.room_id = ?
    `).get(roomId) as {
      id: string;
      room_id: string;
      status: string;
      state_revision: number;
      answer_duration_seconds: number;
      current_turn_player_id: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
      room_code: string;
    } | null;

    if (!row) return null;

    return {
      id: row.id,
      roomId: row.room_id,
      roomCode: row.room_code,
      status: row.status as GameStatus,
      revision: row.state_revision,
      answerDurationSeconds: row.answer_duration_seconds,
      currentTurnPlayerId: row.current_turn_player_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    };
  }

  getPlayerGameStates(gameId: string): PlayerGameStateEntity[] {
    const rows = this.db.prepare(`
      SELECT 
        pgs.id,
        pgs.game_id,
        pgs.player_id,
        pgs.turn_order,
        pgs.assigned_character_id,
        pgs.character_name,
        pgs.character_series,
        pgs.character_image_url,
        pgs.character_description,
        pgs.character_snapshot_json,
        pgs.has_guessed_correctly,
        pgs.completed_at,
        pgs.point_balance,
        p.name as player_name,
        p.type as player_type,
        p.connected
      FROM player_game_state pgs
      JOIN players p ON pgs.player_id = p.id
      WHERE pgs.game_id = ?
      ORDER BY pgs.turn_order ASC
    `).all(gameId) as Array<{
      id: string;
      game_id: string;
      player_id: string;
      turn_order: number;
      assigned_character_id: string;
      character_name: string;
      character_series: string;
      character_image_url: string | null;
      character_description: string | null;
      character_snapshot_json: string | null;
      has_guessed_correctly: number;
      completed_at: string | null;
      point_balance: number;
      player_name: string;
      player_type: string;
      connected: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      gameId: r.game_id,
      playerId: r.player_id,
      playerName: r.player_name,
      playerType: r.player_type as PlayerType,
      turnOrder: r.turn_order,
      connected: Boolean(r.connected),
      hasGuessedCorrectly: Boolean(r.has_guessed_correctly),
      completedAt: r.completed_at,
      pointBalance: r.point_balance,
      character: (() => {
        const legacy = { id: r.assigned_character_id, name: r.character_name, series: r.character_series, imageUrl: r.character_image_url ?? undefined, description: r.character_description ?? undefined };
        try {
          const snapshot: unknown = r.character_snapshot_json ? JSON.parse(r.character_snapshot_json) : null;
          if (!snapshot || typeof snapshot !== "object") return legacy;
          const value = snapshot as Record<string, unknown>;
          if (typeof value.id !== "string" || !value.id.trim() || typeof value.name !== "string" || !value.name.trim() || typeof value.series !== "string" || !value.series.trim()) return legacy;
          if (value.description !== undefined && typeof value.description !== "string") return legacy;
          if (value.imageUrl !== undefined && typeof value.imageUrl !== "string") return legacy;
          if (value.knowledge !== undefined && (!value.knowledge || typeof value.knowledge !== "object" || Array.isArray(value.knowledge))) return legacy;
          return snapshot as CharacterSummary;
        } catch { return legacy; }
      })()
    }));
  }

  createGameWithAssignments(
    roomId: string,
    assignments: Array<{ playerId: string; character: CharacterSummary; turnOrder: number }>
  ): GameEntity {
    const gameId = randomUUID();
    const now = new Date().toISOString();
    const firstTurnPlayerId = assignments.find((a) => a.turnOrder === 0)?.playerId ?? assignments[0].playerId;
    const firstTurnId = randomUUID();

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO games (id, room_id, status, answer_duration_seconds, current_turn_player_id, created_at, started_at, finished_at)
        SELECT ?, ?, 'playing', answer_duration_seconds, ?, ?, ?, NULL FROM rooms WHERE id = ?
      `).run(gameId, roomId, firstTurnPlayerId, now, now, roomId);

      const pgsStmt = this.db.prepare(`
        INSERT INTO player_game_state (
          id, game_id, player_id, assigned_character_id, character_name, character_series, character_image_url, character_description, character_snapshot_json, turn_order, has_guessed_correctly, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      `);

      for (const item of assignments) {
        const character = sanitizeCharacter(item.character);
        pgsStmt.run(
          randomUUID(),
          gameId,
          item.playerId,
          character.id,
          character.name,
          character.series,
          character.imageUrl ?? null,
          character.description ?? null,
          JSON.stringify(character),
          item.turnOrder
        );
      }

      // Atomically create first turn in waiting_for_question phase
      this.db.prepare(`
        INSERT INTO game_turns (id, game_id, active_player_id, turn_number, phase, is_active, started_at, ended_at)
        VALUES (?, ?, ?, 1, 'waiting_for_question', 1, ?, NULL)
      `).run(firstTurnId, gameId, firstTurnPlayerId, now);
    });

    tx();

    const created = this.getGameByRoomId(roomId);
    if (!created) {
      throw new Error("Failed to retrieve created game");
    }
    return created;
  }
}
