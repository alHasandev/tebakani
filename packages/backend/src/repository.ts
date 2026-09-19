import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { Player, Room } from "@tebakani/shared";
import { generateRoomCode, generateSessionToken } from "./utils";
import { DomainError } from "./errors";

interface RoomRow { id: string; code: string; answer_duration_seconds: number; created_at: string }

function mapRoom(row: RoomRow): Room {
  return { id: row.id, code: row.code, answerDurationSeconds: row.answer_duration_seconds, createdAt: row.created_at };
}
interface PlayerRow { id: string; room_id: string; name: string; type: string; is_host: number; session_token: string | null; connected: number; created_at: string }

function mapPlayer(row: PlayerRow): Player {
  return { id: row.id, roomId: row.room_id, name: row.name, type: row.type as "human" | "ai", isHost: Boolean(row.is_host), connected: row.type === "human" && Boolean(row.connected), createdAt: row.created_at };
}

export class RoomRepository {
  constructor(private db: Database) {}

  createRoom(creatorName: string): { room: Room; player: Player; sessionToken: string } {
    let code = "";
    let roomId = "";
    const now = new Date().toISOString();
    for (let attempts = 0; attempts < 10; attempts++) {
      code = generateRoomCode();
      roomId = randomUUID();
      try {
        this.db.prepare("INSERT INTO rooms (id, code, created_at) VALUES (?, ?, ?)").run(roomId, code, now);
        break;
      } catch (error: any) {
        if (error?.message?.includes("rooms.code") && attempts < 9) continue;
        throw error;
      }
    }
    const playerId = randomUUID();
    const sessionToken = generateSessionToken();
    this.db.prepare("INSERT INTO players (id, room_id, name, type, is_host, session_token, connected, created_at) VALUES (?, ?, ?, 'human', 1, ?, 0, ?)").run(playerId, roomId, creatorName, sessionToken, now);
    return { room: { id: roomId, code, answerDurationSeconds: 60, createdAt: now }, player: { id: playerId, roomId, name: creatorName, type: "human", isHost: true, connected: false, createdAt: now }, sessionToken };
  }

  getRoomByCode(code: string): Room | null {
    const row = this.db.prepare("SELECT id, code, answer_duration_seconds, created_at FROM rooms WHERE code = ?").get(code.toUpperCase()) as RoomRow | null;
    return row ? mapRoom(row) : null;
  }

  updateAnswerDuration(roomId: string, requesterPlayerId: string, seconds: number): Room {
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300) throw new DomainError(400, "Answer duration must be an integer between 15 and 300 seconds");
    this.db.transaction(() => {
      const requester = this.db.prepare("SELECT is_host, type FROM players WHERE id = ? AND room_id = ?").get(requesterPlayerId, roomId) as { is_host: number; type: string } | null;
      if (!requester || !requester.is_host || requester.type !== "human") throw new DomainError(403, "Only the human host can update the answer timer");
      if (this.db.prepare("SELECT id FROM games WHERE room_id = ?").get(roomId)) throw new DomainError(409, "Answer timer can only be changed before the game starts");
      this.db.prepare("UPDATE rooms SET answer_duration_seconds = ? WHERE id = ?").run(seconds, roomId);
    })();
    return this.getRoomByCode((this.db.prepare("SELECT code FROM rooms WHERE id = ?").get(roomId) as { code: string }).code)!;
  }

  joinRoom(code: string, playerName: string, playerType: "human" | "ai" = "human"): { status: "success"; room: Room; player: Player; sessionToken: string } | { status: "not_found" } | { status: "game_already_started" } {
    const room = this.getRoomByCode(code);
    if (!room) return { status: "not_found" };
    if (playerType === "ai") {
      try {
        const player = this.addAIPlayers(room.id, [playerName])[0];
        return { status: "success", room, player, sessionToken: "" };
      } catch (error) {
        if (error instanceof DomainError && error.status === 409) return { status: "game_already_started" };
        throw error;
      }
    }
    const playerId = randomUUID();
    const sessionToken = generateSessionToken();
    const now = new Date().toISOString();
    let joined = false;
    this.db.transaction(() => {
      if (this.db.prepare("SELECT id FROM games WHERE room_id = ?").get(room.id)) return;
      this.db.prepare("INSERT INTO players (id, room_id, name, type, is_host, session_token, connected, created_at) VALUES (?, ?, ?, 'human', 0, ?, 0, ?)").run(playerId, room.id, playerName, sessionToken, now);
      joined = true;
    })();
    if (!joined) return { status: "game_already_started" };
    return { status: "success", room, player: { id: playerId, roomId: room.id, name: playerName, type: "human", isHost: false, connected: false, createdAt: now }, sessionToken };
  }

  getPlayers(roomId: string): Player[] {
    return (this.db.prepare("SELECT * FROM players WHERE room_id = ? ORDER BY created_at, rowid").all(roomId) as PlayerRow[]).map(mapPlayer);
  }

  authenticatePlayer(token: string): { player: Player; room: Room } | null {
    const row = this.db.prepare(`SELECT p.*, r.code room_code, r.created_at room_created_at FROM players p JOIN rooms r ON p.room_id = r.id WHERE p.session_token = ? AND p.type = 'human'`).get(token) as (PlayerRow & { room_code: string; room_created_at: string }) | null;
    if (!row) return null;
    const room = this.getRoomByCode(row.room_code);
    return room ? { player: mapPlayer(row), room } : null;
  }

  addAIPlayers(roomId: string, requestedNames: Array<string | null>, maximumPlayers = 12): Player[] {
    if (!requestedNames.length) throw new DomainError(400, "At least one AI player is required");
    let created: Player[] = [];
    this.db.transaction(() => {
      if (this.db.prepare("SELECT id FROM games WHERE room_id = ?").get(roomId)) throw new DomainError(409, "AI players can only be added in the lobby");
      const existing = this.getPlayers(roomId);
      if (existing.length + requestedNames.length > maximumPlayers) throw new DomainError(409, `Room capacity is ${maximumPlayers} players`);
      const used = new Set(existing.map((player) => player.name.trim().toLocaleLowerCase()));
      const resolved = requestedNames.map((raw) => {
        const explicit = raw?.trim();
        let name = explicit ?? "";
        if (!name) {
          let index = 1;
          while (used.has(`ai player ${index}`)) index++;
          name = `AI Player ${index}`;
        }
        const key = name.toLocaleLowerCase();
        if (used.has(key)) throw new DomainError(409, `Player name already exists: ${name}`);
        used.add(key);
        return name;
      });
      const now = new Date().toISOString();
      created = resolved.map((name) => {
        const id = randomUUID();
        this.db.prepare("INSERT INTO players (id, room_id, name, type, is_host, session_token, connected, created_at) VALUES (?, ?, ?, 'ai', 0, NULL, 0, ?)").run(id, roomId, name, now);
        return { id, roomId, name, type: "ai", isHost: false, connected: false, createdAt: now };
      });
    })();
    return created;
  }

  removeAIPlayer(roomId: string, playerId: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT type FROM players WHERE id = ? AND room_id = ?").get(playerId, roomId) as { type: string } | null;
      if (!row || row.type !== "ai") throw new DomainError(404, "AI player not found");
      if (this.db.prepare("SELECT id FROM games WHERE room_id = ?").get(roomId)) throw new DomainError(409, "AI players can only be removed in the lobby");
      this.db.prepare("DELETE FROM players WHERE id = ? AND room_id = ? AND type = 'ai'").run(playerId, roomId);
    })();
  }

  setPlayerConnected(playerId: string, connected: boolean): void {
    this.db.prepare("UPDATE players SET connected = ? WHERE id = ? AND type = 'human'").run(connected ? 1 : 0, playerId);
  }
}
