import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db";
import { createApp } from "../src/app";
import { unlinkSync } from "fs";
import { randomUUID } from "crypto";
import { FakeModerator } from "./fake-moderator";

describe("SQLite schema migration idempotency & data preservation through v5", () => {
  const testDbPath = `test_migration_${Date.now()}.sqlite`;

  function cleanup() {
    try {
      unlinkSync(testDbPath);
    } catch {}
    try {
      unlinkSync(`${testDbPath}-wal`);
    } catch {}
    try {
      unlinkSync(`${testDbPath}-shm`);
    } catch {}
  }

  function replaceEconomyWithV7(db: Database) {
    db.run(`
      DROP TRIGGER IF EXISTS point_ledger_no_update;
      DROP TRIGGER IF EXISTS point_ledger_no_delete;
      DROP TRIGGER IF EXISTS game_revision_turn_insert;
      DROP TRIGGER IF EXISTS game_revision_turn_update;
      DROP TRIGGER IF EXISTS game_revision_question_insert;
      DROP TRIGGER IF EXISTS game_revision_question_update;
      DROP TRIGGER IF EXISTS game_revision_answer_insert;
      DROP TRIGGER IF EXISTS game_revision_answer_update;
      DROP TRIGGER IF EXISTS game_revision_state_update;
      DROP TRIGGER IF EXISTS game_revision_hint_insert;
      DROP TABLE point_ledger;
      DROP TABLE purchased_hints;
      CREATE TABLE point_ledger (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, turn_id TEXT,
        amount INTEGER NOT NULL CHECK(amount != 0), reason TEXT NOT NULL CHECK(reason IN ('answer_reward', 'hint_purchase')),
        created_at TEXT NOT NULL, FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE, FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE RESTRICT,
        UNIQUE(turn_id, player_id, reason)
      );
      CREATE TABLE purchased_hints (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL,
        hint_type TEXT NOT NULL CHECK(hint_type IN ('basic_name', 'series', 'candidates')),
        hint_value TEXT NOT NULL, cost INTEGER NOT NULL CHECK(cost > 0), purchased_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE, FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        UNIQUE(game_id, player_id, hint_type)
      );
      PRAGMA user_version = 7;
    `);
  }

  it("migrates legacy database to v3, backfills active waiting_for_question turn for playing games, and allows asking after reopening", async () => {
    cleanup();

    // 1. Manually construct legacy DB matching the v1/v2 schema with a playing game and finished game
    const rawDb = new Database(testDbPath);
    rawDb.run("PRAGMA foreign_keys = ON;");
    rawDb.run(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);

    rawDb.run(`
      CREATE TABLE players (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('human', 'ai')),
        is_host INTEGER NOT NULL DEFAULT 0,
        session_token TEXT NOT NULL UNIQUE,
        connected INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );
    `);

    rawDb.run(`
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed')),
        current_turn_player_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        FOREIGN KEY(current_turn_player_id) REFERENCES players(id)
      );
    `);

    rawDb.run(`
      CREATE TABLE player_game_state (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        character_series TEXT NOT NULL,
        character_image_url TEXT,
        character_description TEXT,
        turn_order INTEGER NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        UNIQUE(game_id, player_id),
        UNIQUE(game_id, character_id),
        UNIQUE(game_id, turn_order)
      );
    `);

    // Insert playing legacy room + game
    const roomId = randomUUID();
    const p1Id = randomUUID();
    const p2Id = randomUUID();
    const gameId = randomUUID();
    const timestamp = "2026-09-18T10:00:00.000Z";

    rawDb.run("INSERT INTO rooms VALUES (?, ?, ?);", [roomId, "LEGACY", timestamp]);
    rawDb.run("INSERT INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?);", [
      p1Id,
      roomId,
      "LegacyHost",
      "human",
      1,
      "token_host_123",
      1,
      timestamp
    ]);
    rawDb.run("INSERT INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?);", [
      p2Id,
      roomId,
      "LegacyGuest",
      "human",
      0,
      "token_guest_456",
      0,
      timestamp
    ]);
    rawDb.run("INSERT INTO games VALUES (?, ?, ?, ?, ?);", [
      gameId,
      roomId,
      "in_progress",
      p1Id,
      timestamp
    ]);
    rawDb.run("INSERT INTO player_game_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);", [
      randomUUID(),
      gameId,
      p1Id,
      "char_legacy_1",
      "Goku",
      "Dragon Ball",
      null,
      "Saiyan warrior",
      0
    ]);
    rawDb.run("INSERT INTO player_game_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);", [
      randomUUID(),
      gameId,
      p2Id,
      "char_legacy_2",
      "Vegeta",
      "Dragon Ball",
      null,
      "Saiyan prince",
      1
    ]);

    // Insert completed legacy room + game (should NOT get backfilled active turn)
    const roomDoneId = randomUUID();
    const pDoneId = randomUUID();
    const gameDoneId = randomUUID();
    rawDb.run("INSERT INTO rooms VALUES (?, ?, ?);", [roomDoneId, "DONE99", timestamp]);
    rawDb.run("INSERT INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?);", [
      pDoneId,
      roomDoneId,
      "DonePlayer",
      "human",
      1,
      "token_done_789",
      0,
      timestamp
    ]);
    rawDb.run("INSERT INTO games VALUES (?, ?, ?, ?, ?);", [
      gameDoneId,
      roomDoneId,
      "completed",
      pDoneId,
      timestamp
    ]);

    rawDb.close();

    // 2. Open via createDatabase() to trigger migration to v3
    const db = createDatabase(testDbPath);

    // Verify user_version is 9
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(versionRow.user_version).toBe(12);
    const stateColumns = db.prepare("PRAGMA table_info(player_game_state);").all() as Array<{ name: string }>;
    expect(stateColumns.some((column) => column.name === "point_balance")).toBe(true);
    expect(db.prepare("SELECT point_balance FROM player_game_state WHERE game_id = ?").all(gameId).every((row: any) => row.point_balance === 0)).toBe(true);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('point_ledger', 'purchased_hints')").all()).toHaveLength(2);

    // Verify foreign key integrity
    const fkErrors = db.prepare("PRAGMA foreign_key_check;").all();
    expect(fkErrors).toHaveLength(0);

    // Verify playing game backfilled exactly one active turn
    const activeTurnsPlaying = db.prepare("SELECT * FROM game_turns WHERE game_id = ? AND is_active = 1").all(gameId) as any[];
    expect(activeTurnsPlaying).toHaveLength(1);
    expect(activeTurnsPlaying[0].turn_number).toBe(1);
    expect(activeTurnsPlaying[0].phase).toBe("waiting_for_question");
    expect(activeTurnsPlaying[0].active_player_id).toBe(p1Id);

    // Verify finished game has ZERO active turns
    const activeTurnsFinished = db.prepare("SELECT * FROM game_turns WHERE game_id = ? AND is_active = 1").all(gameDoneId) as any[];
    expect(activeTurnsFinished).toHaveLength(0);

    db.close();

    const reopened = createDatabase(testDbPath);
    expect((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
    expect(reopened.prepare("SELECT COUNT(*) count FROM games").get()).toEqual({ count: 2 });
    expect(reopened.prepare("SELECT COUNT(*) count FROM player_game_state").get()).toEqual({ count: 2 });
    reopened.close();

    // 3. Reopen via createApp and verify active turn functions properly (can ask question)
    const { app } = createApp(testDbPath, undefined, { moderator: new FakeModerator() });
    const gameRes = await app.handle(
      new Request("http://localhost/rooms/LEGACY/game", {
        headers: { Authorization: "Bearer token_host_123" }
      })
    );
    const gameData = await gameRes.json();
    const turnId = gameData.currentTurn.id;

    const askRes = await app.handle(
      new Request("http://localhost/rooms/LEGACY/game/question", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token_host_123"
        },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Is my character an alien?" })
      })
    );
    expect(askRes.status).toBe(200);
    const afterAsk = await askRes.json();
    expect(afterAsk.currentTurn.phase).toBe("collecting_answers");
    expect(afterAsk.currentTurn.question.questionText).toBe("Is my character an alien?");

    cleanup();
  });

  it("migrates populated v7 economy rows one-to-one without changing historical amounts or balances", () => {
    cleanup();
    const seeded = createDatabase(testDbPath);
    const roomId = randomUUID();
    const playerId = randomUUID();
    const gameId = randomUUID();
    const turnId = randomUUID();
    const questionId = randomUUID();
    const timestamp = "2026-09-18T12:00:00.000Z";
    seeded.run("INSERT INTO rooms VALUES (?, 'V7DATA', ?)", [roomId, timestamp]);
    seeded.run("INSERT INTO players VALUES (?, ?, 'Player', 'human', 1, 'v7-token', 0, ?)", [playerId, roomId, timestamp]);
    seeded.run("INSERT INTO games (id, room_id, status, current_turn_player_id, created_at, started_at, finished_at, state_revision) VALUES (?, ?, 'playing', ?, ?, ?, NULL, 0)", [gameId, roomId, playerId, timestamp, timestamp]);
    seeded.run("INSERT INTO player_game_state VALUES (?, ?, ?, 'char', 'Name', 'Series', NULL, 'Description', 0, 0, NULL, 3, NULL)", [randomUUID(), gameId, playerId]);
    seeded.run("INSERT INTO game_turns VALUES (?, ?, ?, 1, 'awaiting_guess', 1, ?, NULL)", [turnId, gameId, playerId, timestamp]);
    seeded.run("INSERT INTO questions (id, turn_id, asking_player_id, question_text, asked_at, moderator_status, moderator_answer, moderator_error, moderator_claim_token, moderator_attempts, moderated_at, moderator_revision) VALUES (?, ?, ?, 'Q?', ?, 'answered', 'yes', NULL, NULL, 1, ?, 1)", [questionId, turnId, playerId, timestamp, timestamp]);
    replaceEconomyWithV7(seeded);
    seeded.run("INSERT INTO purchased_hints VALUES ('hint-a', ?, ?, 'basic_name', '\"clue\"', 5, ?)", [gameId, playerId, timestamp]);
    seeded.run("INSERT INTO purchased_hints VALUES ('hint-b', ?, ?, 'series', '\"series\"', 2, ?)", [gameId, playerId, timestamp]);
    seeded.run("INSERT INTO point_ledger VALUES ('ledger-a', ?, ?, NULL, -5, 'hint_purchase', ?)", [gameId, playerId, timestamp]);
    seeded.run("INSERT INTO point_ledger VALUES ('ledger-b', ?, ?, NULL, -2, 'hint_purchase', ?)", [gameId, playerId, timestamp]);
    seeded.run("INSERT INTO point_ledger VALUES ('ledger-reward', ?, ?, ?, 10, 'answer_reward', ?)", [gameId, playerId, turnId, timestamp]);
    seeded.close();

    const migrated = createDatabase(testDbPath);
    expect((migrated.prepare("PRAGMA user_version").get() as any).user_version).toBe(12);
    expect(migrated.prepare("SELECT id, hint_type, cost FROM purchased_hints ORDER BY id").all()).toEqual([
      { id: "hint-a", hint_type: "basic", cost: 5 },
      { id: "hint-b", hint_type: "series", cost: 2 }
    ]);
    expect(migrated.prepare("SELECT id, question_id, hint_purchase_id, amount, reason FROM point_ledger ORDER BY id").all()).toEqual([
      { id: "ledger-a", question_id: null, hint_purchase_id: "hint-a", amount: -5, reason: "hint_purchase" },
      { id: "ledger-b", question_id: null, hint_purchase_id: "hint-b", amount: -2, reason: "hint_purchase" },
      { id: "ledger-reward", question_id: questionId, hint_purchase_id: null, amount: 10, reason: "answer_match" }
    ]);
    expect(migrated.prepare("SELECT point_balance FROM player_game_state WHERE player_id = ?").get(playerId)).toEqual({ point_balance: 3 });
    expect(migrated.prepare("SELECT COALESCE(SUM(amount), 0) total FROM point_ledger WHERE player_id = ?").get(playerId)).toEqual({ total: 3 });
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    migrated.close();

    const reopened = createDatabase(testDbPath);
    expect((reopened.prepare("PRAGMA user_version").get() as any).user_version).toBe(12);
    expect(reopened.prepare("SELECT COUNT(*) count FROM point_ledger").get()).toEqual({ count: 3 });
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    reopened.close();
    cleanup();
  });

  it("advances from user_version=7 when point_ledger/purchased_hints already have v8 columns (version-drift regression)", () => {
    cleanup();
    const raw = new Database(testDbPath);
    raw.run("PRAGMA foreign_keys = OFF;");
    raw.run(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE players (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE, type TEXT NOT NULL CHECK(type IN ('human', 'ai')), is_host INTEGER NOT NULL DEFAULT 0, session_token TEXT UNIQUE, connected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, CHECK((type = 'human' AND session_token IS NOT NULL) OR (type = 'ai' AND session_token IS NULL)), FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE, UNIQUE(room_id, name));
      CREATE TABLE games (id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('lobby', 'playing', 'finished')), current_turn_player_id TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, state_revision INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE, FOREIGN KEY(current_turn_player_id) REFERENCES players(id));
      CREATE TABLE player_game_state (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, assigned_character_id TEXT NOT NULL, character_name TEXT NOT NULL, character_series TEXT NOT NULL, character_image_url TEXT, character_description TEXT, turn_order INTEGER NOT NULL, has_guessed_correctly INTEGER NOT NULL DEFAULT 0, completed_at TEXT, point_balance INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE, FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE, UNIQUE(game_id, player_id), UNIQUE(game_id, assigned_character_id), UNIQUE(game_id, turn_order));
      CREATE TABLE game_turns (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, active_player_id TEXT NOT NULL, turn_number INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('waiting_for_question', 'collecting_answers', 'awaiting_guess')), is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)), started_at TEXT NOT NULL, ended_at TEXT, FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE, FOREIGN KEY(active_player_id) REFERENCES players(id) ON DELETE CASCADE, UNIQUE(game_id, turn_number));
      CREATE UNIQUE INDEX idx_active_turn_per_game ON game_turns(game_id) WHERE is_active = 1;
      CREATE TABLE questions (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE, asking_player_id TEXT NOT NULL, question_text TEXT NOT NULL, asked_at TEXT NOT NULL, moderator_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderator_status IN ('pending', 'answered', 'failed')), moderator_answer TEXT CHECK(moderator_answer IN ('yes', 'no', 'maybe')), moderator_error TEXT, moderator_claim_token TEXT, moderator_attempts INTEGER NOT NULL DEFAULT 0, moderated_at TEXT, moderator_revision INTEGER NOT NULL DEFAULT 0 CHECK(moderator_revision >= 0), FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE CASCADE, FOREIGN KEY(asking_player_id) REFERENCES players(id) ON DELETE CASCADE);
      CREATE TABLE turn_answers (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, answering_player_id TEXT NOT NULL, answer TEXT NOT NULL CHECK(answer IN ('yes', 'no', 'maybe')), answered_at TEXT NOT NULL, FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE, FOREIGN KEY(answering_player_id) REFERENCES players(id) ON DELETE CASCADE, UNIQUE(question_id, answering_player_id));
      CREATE TABLE purchased_hints (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, hint_type TEXT NOT NULL CHECK(hint_type IN ('basic', 'series', 'candidates')), hint_value TEXT NOT NULL, cost INTEGER NOT NULL CHECK(typeof(cost) = 'integer' AND cost > 0), purchased_at TEXT NOT NULL, FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE, FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE, UNIQUE(game_id, player_id, hint_type));
      CREATE TABLE point_ledger (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, question_id TEXT, hint_purchase_id TEXT, amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer'), reason TEXT NOT NULL CHECK(reason IN ('answer_match', 'hint_purchase')), created_at TEXT NOT NULL, FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE, FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE, FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE RESTRICT, FOREIGN KEY(hint_purchase_id) REFERENCES purchased_hints(id) ON DELETE RESTRICT, CHECK((reason = 'answer_match' AND amount > 0 AND question_id IS NOT NULL AND hint_purchase_id IS NULL) OR (reason = 'hint_purchase' AND amount < 0 AND question_id IS NULL AND hint_purchase_id IS NOT NULL)), UNIQUE(question_id, player_id, reason), UNIQUE(hint_purchase_id));
      PRAGMA user_version = 7;
    `);

    const roomId = randomUUID();
    const playerId = randomUUID();
    const gameId = randomUUID();
    const turnId = randomUUID();
    const questionId = randomUUID();
    const hintId = randomUUID();
    const ledgerHintId = randomUUID();
    const ledgerRewardId = randomUUID();
    const timestamp = "2026-09-19T00:00:00.000Z";
    raw.run("INSERT INTO rooms VALUES (?, 'DRIFTV7', ?)", [roomId, timestamp]);
    raw.run("INSERT INTO players VALUES (?, ?, 'DriftPlayer', 'human', 1, 'drift-token', 0, ?)", [playerId, roomId, timestamp]);
    raw.run("INSERT INTO games VALUES (?, ?, 'playing', ?, ?, ?, NULL, 0)", [gameId, roomId, playerId, timestamp, timestamp]);
    raw.run("INSERT INTO player_game_state VALUES (?, ?, ?, 'char-drift', 'Drift', 'Series', NULL, NULL, 0, 0, NULL, 5)", [randomUUID(), gameId, playerId]);
    raw.run("INSERT INTO game_turns VALUES (?, ?, ?, 1, 'awaiting_guess', 1, ?, NULL)", [turnId, gameId, playerId, timestamp]);
    raw.run("INSERT INTO questions VALUES (?, ?, ?, 'Is it a hero?', ?, 'answered', 'yes', NULL, NULL, 1, ?, 1)", [questionId, turnId, playerId, timestamp, timestamp]);
    raw.run("INSERT INTO purchased_hints VALUES (?, ?, ?, 'basic', '\"Drift\"', 5, ?)", [hintId, gameId, playerId, timestamp]);
    raw.run("INSERT INTO point_ledger VALUES (?, ?, ?, NULL, ?, -5, 'hint_purchase', ?)", [ledgerHintId, gameId, playerId, hintId, timestamp]);
    raw.run("INSERT INTO point_ledger VALUES (?, ?, ?, ?, NULL, 10, 'answer_match', ?)", [ledgerRewardId, gameId, playerId, questionId, timestamp]);
    raw.close();

    const migrated = createDatabase(testDbPath);
    expect((migrated.prepare("PRAGMA user_version").get() as any).user_version).toBe(12);
    expect(migrated.prepare("SELECT id, hint_type, cost FROM purchased_hints").all()).toEqual([{ id: hintId, hint_type: "basic", cost: 5 }]);
    expect(migrated.prepare("SELECT id, question_id, hint_purchase_id, amount, reason FROM point_ledger ORDER BY amount").all()).toEqual([
      { id: ledgerHintId, question_id: null, hint_purchase_id: hintId, amount: -5, reason: "hint_purchase" },
      { id: ledgerRewardId, question_id: questionId, hint_purchase_id: null, amount: 10, reason: "answer_match" }
    ]);
    expect(migrated.prepare("SELECT point_balance FROM player_game_state WHERE player_id = ?").get(playerId)).toEqual({ point_balance: 5 });
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    migrated.close();

    const reopened = createDatabase(testDbPath);
    expect((reopened.prepare("PRAGMA user_version").get() as any).user_version).toBe(12);
    expect(reopened.prepare("SELECT COUNT(*) count FROM point_ledger").get()).toEqual({ count: 2 });
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    reopened.close();
    cleanup();
  });

  it("rejects version=7 with already v8-shaped tables but invalid data (version-drift + bad data)", () => {
    cleanup();
    const raw = new Database(testDbPath);
    raw.run("PRAGMA foreign_keys = OFF;");
    raw.run(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE players (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE, type TEXT NOT NULL CHECK(type IN ('human', 'ai')), is_host INTEGER NOT NULL DEFAULT 0, session_token TEXT UNIQUE, connected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, CHECK((type = 'human' AND session_token IS NOT NULL) OR (type = 'ai' AND session_token IS NULL)), FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE, UNIQUE(room_id, name));
      CREATE TABLE games (id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('lobby', 'playing', 'finished')), current_turn_player_id TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, state_revision INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE, FOREIGN KEY(current_turn_player_id) REFERENCES players(id));
      CREATE TABLE player_game_state (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, assigned_character_id TEXT NOT NULL, character_name TEXT NOT NULL, character_series TEXT NOT NULL, character_image_url TEXT, character_description TEXT, turn_order INTEGER NOT NULL, has_guessed_correctly INTEGER NOT NULL DEFAULT 0, completed_at TEXT, point_balance INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE, FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE, UNIQUE(game_id, player_id), UNIQUE(game_id, assigned_character_id), UNIQUE(game_id, turn_order));
      CREATE TABLE game_turns (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, active_player_id TEXT NOT NULL, turn_number INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('waiting_for_question', 'collecting_answers', 'awaiting_guess')), is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)), started_at TEXT NOT NULL, ended_at TEXT, FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE, FOREIGN KEY(active_player_id) REFERENCES players(id) ON DELETE CASCADE, UNIQUE(game_id, turn_number));
      CREATE UNIQUE INDEX idx_active_turn_per_game ON game_turns(game_id) WHERE is_active = 1;
      CREATE TABLE questions (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE, asking_player_id TEXT NOT NULL, question_text TEXT NOT NULL, asked_at TEXT NOT NULL, moderator_status TEXT NOT NULL DEFAULT 'pending', moderator_answer TEXT, moderator_error TEXT, moderator_claim_token TEXT, moderator_attempts INTEGER NOT NULL DEFAULT 0, moderated_at TEXT, moderator_revision INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE CASCADE, FOREIGN KEY(asking_player_id) REFERENCES players(id) ON DELETE CASCADE);
      CREATE TABLE turn_answers (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, answering_player_id TEXT NOT NULL, answer TEXT NOT NULL CHECK(answer IN ('yes', 'no', 'maybe')), answered_at TEXT NOT NULL, FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE, FOREIGN KEY(answering_player_id) REFERENCES players(id) ON DELETE CASCADE, UNIQUE(question_id, answering_player_id));
      CREATE TABLE purchased_hints (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, hint_type TEXT NOT NULL, hint_value TEXT NOT NULL, cost INTEGER NOT NULL, purchased_at TEXT NOT NULL);
      CREATE TABLE point_ledger (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_id TEXT NOT NULL, question_id TEXT, hint_purchase_id TEXT, amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version = 7;
    `);

    const roomId = randomUUID();
    const playerId = randomUUID();
    const gameId = randomUUID();
    const timestamp = "2026-09-19T01:00:00.000Z";
    raw.run("INSERT INTO rooms VALUES (?, 'DRIFTBAD', ?)", [roomId, timestamp]);
    raw.run("INSERT INTO players VALUES (?, ?, 'BadPlayer', 'human', 1, 'bad-drift-token', 0, ?)", [playerId, roomId, timestamp]);
    raw.run("INSERT INTO games VALUES (?, ?, 'playing', NULL, ?, NULL, NULL, 0)", [gameId, roomId, timestamp]);
    raw.run("INSERT INTO player_game_state VALUES (?, ?, ?, 'c1', 'N', 'S', NULL, NULL, 0, 0, NULL, 0)", [randomUUID(), gameId, playerId]);
    raw.run("INSERT INTO purchased_hints VALUES ('ph-bad', ?, ?, 'INVALID_TYPE', '\"x\"', 5, ?)", [gameId, playerId, timestamp]);
    raw.run("INSERT INTO point_ledger VALUES ('pl-bad', ?, ?, NULL, 'ph-bad', -5, 'hint_purchase', ?)", [gameId, playerId, timestamp]);
    raw.close();

    expect(() => createDatabase(testDbPath)).toThrow("Cannot advance v8 economy schema: existing data failed validation");
    const check = new Database(testDbPath);
    expect((check.prepare("PRAGMA user_version").get() as any).user_version).toBe(7);
    check.close();
    cleanup();
  });

  it("rejects unmatched v7 hint ledger rows atomically without dropping history", () => {
    cleanup();
    const seeded = createDatabase(testDbPath);
    const roomId = randomUUID();
    const playerId = randomUUID();
    const gameId = randomUUID();
    const timestamp = "2026-09-18T13:00:00.000Z";
    seeded.run("INSERT INTO rooms VALUES (?, 'V7BAD1', ?)", [roomId, timestamp]);
    seeded.run("INSERT INTO players VALUES (?, ?, 'Player', 'human', 1, 'v7-bad-token', 0, ?)", [playerId, roomId, timestamp]);
    seeded.run("INSERT INTO games (id, room_id, status, current_turn_player_id, created_at, started_at, finished_at, state_revision) VALUES (?, ?, 'playing', ?, ?, ?, NULL, 0)", [gameId, roomId, playerId, timestamp, timestamp]);
    seeded.run("INSERT INTO player_game_state VALUES (?, ?, ?, 'char', 'Name', 'Series', NULL, 'Description', 0, 0, NULL, 0, NULL)", [randomUUID(), gameId, playerId]);
    replaceEconomyWithV7(seeded);
    seeded.run("INSERT INTO point_ledger VALUES ('orphan-ledger', ?, ?, NULL, -1, 'hint_purchase', ?)", [gameId, playerId, timestamp]);
    seeded.close();

    expect(() => createDatabase(testDbPath)).toThrow("hint purchases and ledger rows cannot be paired one-to-one");
    const raw = new Database(testDbPath);
    expect((raw.prepare("PRAGMA user_version").get() as any).user_version).toBe(7);
    expect(raw.prepare("SELECT id, amount FROM point_ledger").all()).toEqual([{ id: "orphan-ledger", amount: -1 }]);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'point_ledger_v8'").get()).toBeNull();
    raw.close();
    cleanup();
  });
});
