import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export function createDatabase(dbPath = ":memory:") {
  const db = new Database(dbPath);

  // 1. Ensure foreign keys off during table rebuild migrations
  db.run("PRAGMA foreign_keys = OFF;");

  // Read current version
  const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
  const currentVersion = versionRow?.user_version ?? 0;

  // Introspect tables
  const gamesTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='games';").get() as { sql: string } | null;
  const pgsTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='player_game_state';").get() as { sql: string } | null;
  const turnsTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='game_turns';").get() as { sql: string } | null;

  const needsV2Migration =
    currentVersion < 2 ||
    (gamesTableInfo && (!gamesTableInfo.sql.includes("started_at") || gamesTableInfo.sql.includes("in_progress"))) ||
    (pgsTableInfo && (!pgsTableInfo.sql.includes("assigned_character_id") || /(?:^|[\s,(])character_id\s+TEXT/i.test(pgsTableInfo.sql)));

  const needsV3Migration = currentVersion < 3 || !turnsTableInfo;

  if (needsV2Migration || needsV3Migration) {
    const migrateTx = db.transaction(() => {
      // Create baseline rooms/players if not present
      db.run(`
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS players (
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

      // Games table
      if (gamesTableInfo && needsV2Migration) {
        db.run(`
          CREATE TABLE games_new (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK(status IN ('lobby', 'playing', 'finished')),
            current_turn_player_id TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY(current_turn_player_id) REFERENCES players(id)
          );
        `);

        const hasStartedAt = gamesTableInfo.sql.includes("started_at");
        if (hasStartedAt) {
          db.run(`
            INSERT INTO games_new (id, room_id, status, current_turn_player_id, created_at, started_at, finished_at)
            SELECT
              id,
              room_id,
              CASE
                WHEN status = 'in_progress' THEN 'playing'
                WHEN status = 'completed' THEN 'finished'
                ELSE status
              END,
              current_turn_player_id,
              created_at,
              COALESCE(started_at, created_at),
              CASE
                WHEN status IN ('completed', 'finished') THEN COALESCE(finished_at, created_at)
                ELSE finished_at
              END
            FROM games;
          `);
        } else {
          db.run(`
            INSERT INTO games_new (id, room_id, status, current_turn_player_id, created_at, started_at, finished_at)
            SELECT
              id,
              room_id,
              CASE
                WHEN status = 'in_progress' THEN 'playing'
                WHEN status = 'completed' THEN 'finished'
                ELSE status
              END,
              current_turn_player_id,
              created_at,
              created_at,
              CASE
                WHEN status = 'completed' THEN created_at
                ELSE NULL
              END
            FROM games;
          `);
        }

        db.run("DROP TABLE games;");
        db.run("ALTER TABLE games_new RENAME TO games;");
      } else {
        db.run(`
          CREATE TABLE IF NOT EXISTS games (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK(status IN ('lobby', 'playing', 'finished')),
            current_turn_player_id TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY(current_turn_player_id) REFERENCES players(id)
          );
        `);
      }

      // Player game state table
      if (pgsTableInfo && needsV2Migration) {
        db.run(`
          CREATE TABLE player_game_state_new (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            assigned_character_id TEXT NOT NULL,
            character_name TEXT NOT NULL,
            character_series TEXT NOT NULL,
            character_image_url TEXT,
            character_description TEXT,
            turn_order INTEGER NOT NULL,
            has_guessed_correctly INTEGER NOT NULL DEFAULT 0,
            completed_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
            UNIQUE(game_id, player_id),
            UNIQUE(game_id, assigned_character_id),
            UNIQUE(game_id, turn_order)
          );
        `);

        const hasAssignedChar = pgsTableInfo.sql.includes("assigned_character_id");
        if (hasAssignedChar) {
          db.run(`
            INSERT INTO player_game_state_new (
              id, game_id, player_id, assigned_character_id, character_name, character_series,
              character_image_url, character_description, turn_order, has_guessed_correctly, completed_at
            )
            SELECT
              id, game_id, player_id, assigned_character_id, character_name, character_series,
              character_image_url, character_description, turn_order,
              COALESCE(has_guessed_correctly, 0),
              completed_at
            FROM player_game_state;
          `);
        } else {
          db.run(`
            INSERT INTO player_game_state_new (
              id, game_id, player_id, assigned_character_id, character_name, character_series,
              character_image_url, character_description, turn_order, has_guessed_correctly, completed_at
            )
            SELECT
              id, game_id, player_id, character_id, character_name, character_series,
              character_image_url, character_description, turn_order,
              0,
              NULL
            FROM player_game_state;
          `);
        }

        db.run("DROP TABLE player_game_state;");
        db.run("ALTER TABLE player_game_state_new RENAME TO player_game_state;");
      } else {
        db.run(`
          CREATE TABLE IF NOT EXISTS player_game_state (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            assigned_character_id TEXT NOT NULL,
            character_name TEXT NOT NULL,
            character_series TEXT NOT NULL,
            character_image_url TEXT,
            character_description TEXT,
            turn_order INTEGER NOT NULL,
            has_guessed_correctly INTEGER NOT NULL DEFAULT 0,
            completed_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
            UNIQUE(game_id, player_id),
            UNIQUE(game_id, assigned_character_id),
            UNIQUE(game_id, turn_order)
          );
        `);
      }

      // Milestone 3: game_turns, questions, turn_answers
      db.run(`
        CREATE TABLE IF NOT EXISTS game_turns (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          active_player_id TEXT NOT NULL,
          turn_number INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('waiting_for_question', 'collecting_answers', 'awaiting_guess')),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY(active_player_id) REFERENCES players(id) ON DELETE CASCADE,
          UNIQUE(game_id, turn_number)
        );
      `);

      // Partial unique index enforcing at most one active turn per game
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_turn_per_game
        ON game_turns(game_id) WHERE is_active = 1;
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL UNIQUE,
          asking_player_id TEXT NOT NULL,
          question_text TEXT NOT NULL,
          asked_at TEXT NOT NULL,
          FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE CASCADE,
          FOREIGN KEY(asking_player_id) REFERENCES players(id) ON DELETE CASCADE
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS turn_answers (
          id TEXT PRIMARY KEY,
          question_id TEXT NOT NULL,
          answering_player_id TEXT NOT NULL,
          answer TEXT NOT NULL CHECK(answer IN ('yes', 'no', 'maybe')),
          answered_at TEXT NOT NULL,
          FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE,
          FOREIGN KEY(answering_player_id) REFERENCES players(id) ON DELETE CASCADE,
          UNIQUE(question_id, answering_player_id)
        );
      `);

      // Backfill active waiting_for_question turn for playing games without active turn
      const playingGamesWithoutActiveTurn = db.prepare(`
        SELECT g.id, g.current_turn_player_id, COALESCE(g.started_at, g.created_at) as started_at
        FROM games g
        LEFT JOIN game_turns gt ON g.id = gt.game_id AND gt.is_active = 1
        WHERE g.status = 'playing' AND gt.id IS NULL AND g.current_turn_player_id IS NOT NULL;
      `).all() as Array<{ id: string; current_turn_player_id: string; started_at: string }>;

      const insertTurnStmt = db.prepare(`
        INSERT INTO game_turns (id, game_id, active_player_id, turn_number, phase, is_active, started_at, ended_at)
        VALUES (?, ?, ?, 1, 'waiting_for_question', 1, ?, NULL);
      `);

      for (const pg of playingGamesWithoutActiveTurn) {
        insertTurnStmt.run(randomUUID(), pg.id, pg.current_turn_player_id, pg.started_at);
      }

      // Indexes
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code);
        CREATE INDEX IF NOT EXISTS idx_players_room_id ON players(room_id);
        CREATE INDEX IF NOT EXISTS idx_players_session_token ON players(session_token);
        CREATE INDEX IF NOT EXISTS idx_games_room_id ON games(room_id);
        CREATE INDEX IF NOT EXISTS idx_player_game_state_game ON player_game_state(game_id);
        CREATE INDEX IF NOT EXISTS idx_player_game_state_player ON player_game_state(player_id);
        CREATE INDEX IF NOT EXISTS idx_game_turns_game ON game_turns(game_id);
        CREATE INDEX IF NOT EXISTS idx_questions_turn ON questions(turn_id);
        CREATE INDEX IF NOT EXISTS idx_turn_answers_question ON turn_answers(question_id);
      `);

      db.run("PRAGMA user_version = 3;");
    });

    migrateTx();
  }

  const questionColumns = db.prepare("PRAGMA table_info(questions);").all() as Array<{ name: string }>;
  const columnNames = new Set(questionColumns.map((column) => column.name));
  const migrateV4 = db.transaction(() => {
    if (!columnNames.has("moderator_status")) {
      db.run("ALTER TABLE questions ADD COLUMN moderator_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderator_status IN ('pending', 'answered', 'failed'));");
    }
    if (!columnNames.has("moderator_answer")) {
      db.run("ALTER TABLE questions ADD COLUMN moderator_answer TEXT CHECK(moderator_answer IN ('yes', 'no', 'maybe'));");
    }
    if (!columnNames.has("moderator_error")) {
      db.run("ALTER TABLE questions ADD COLUMN moderator_error TEXT;");
    }
    if (!columnNames.has("moderator_claim_token")) {
      db.run("ALTER TABLE questions ADD COLUMN moderator_claim_token TEXT;");
    }
    if (!columnNames.has("moderator_attempts")) {
      db.run("ALTER TABLE questions ADD COLUMN moderator_attempts INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnNames.has("moderated_at")) {
      db.run("ALTER TABLE questions ADD COLUMN moderated_at TEXT;");
    }
    db.run("PRAGMA user_version = 4;");
  });
  if (currentVersion < 4) migrateV4();

  const playersTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='players';").get() as { sql: string };
  if (currentVersion < 5 || playersTable.sql.includes("session_token TEXT NOT NULL")) {
    const migrateV5 = db.transaction(() => {
      db.run(`
        CREATE TABLE players_new (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          type TEXT NOT NULL CHECK(type IN ('human', 'ai')),
          is_host INTEGER NOT NULL DEFAULT 0,
          session_token TEXT UNIQUE,
          connected INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          CHECK((type = 'human' AND session_token IS NOT NULL) OR (type = 'ai' AND session_token IS NULL)),
          CHECK(type = 'human' OR (is_host = 0 AND connected = 0)),
          FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
          UNIQUE(room_id, name)
        );
      `);
      db.run(`
        INSERT INTO players_new (id, room_id, name, type, is_host, session_token, connected, created_at)
        SELECT id, room_id, name, type, CASE WHEN type = 'ai' THEN 0 ELSE is_host END,
               CASE WHEN type = 'ai' THEN NULL ELSE session_token END,
               CASE WHEN type = 'ai' THEN 0 ELSE connected END, created_at
        FROM players;
      `);
      db.run("DROP TABLE players;");
      db.run("ALTER TABLE players_new RENAME TO players;");
      db.run("CREATE INDEX idx_players_room_id ON players(room_id);");
      db.run("CREATE INDEX idx_players_session_token ON players(session_token);");
      db.run("PRAGMA user_version = 5;");
    });
    migrateV5();
  }

  if (currentVersion < 6) {
    const v6QuestionColumns = db.prepare("PRAGMA table_info(questions);").all() as Array<{ name: string }>;
    if (!v6QuestionColumns.some((column) => column.name === "moderator_revision")) {
      db.run("ALTER TABLE questions ADD COLUMN moderator_revision INTEGER NOT NULL DEFAULT 0 CHECK(moderator_revision >= 0);");
    }
    db.run("PRAGMA user_version = 6;");
  }

  const v7PlayerStateColumns = db.prepare("PRAGMA table_info(player_game_state);").all() as Array<{ name: string }>;
  const migrateV7 = db.transaction(() => {
    if (!v7PlayerStateColumns.some((column) => column.name === "point_balance")) {
      db.run("ALTER TABLE player_game_state ADD COLUMN point_balance INTEGER NOT NULL DEFAULT 0 CHECK(point_balance >= 0);");
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS point_ledger (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        turn_id TEXT,
        amount INTEGER NOT NULL CHECK(amount != 0),
        reason TEXT NOT NULL CHECK(reason IN ('answer_reward', 'hint_purchase')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE RESTRICT,
        UNIQUE(turn_id, player_id, reason)
      );
      CREATE TABLE IF NOT EXISTS purchased_hints (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        hint_type TEXT NOT NULL CHECK(hint_type IN ('basic_name', 'series', 'candidates')),
        hint_value TEXT NOT NULL,
        cost INTEGER NOT NULL CHECK(cost > 0),
        purchased_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        UNIQUE(game_id, player_id, hint_type)
      );
      CREATE INDEX IF NOT EXISTS idx_point_ledger_game_player ON point_ledger(game_id, player_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_purchased_hints_game_player ON purchased_hints(game_id, player_id, purchased_at);
      CREATE TRIGGER IF NOT EXISTS point_ledger_no_update BEFORE UPDATE ON point_ledger BEGIN SELECT RAISE(ABORT, 'point ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS point_ledger_no_delete BEFORE DELETE ON point_ledger BEGIN SELECT RAISE(ABORT, 'point ledger is immutable'); END;
    `);
    db.run("PRAGMA user_version = 7;");
  });
  if (currentVersion < 7) migrateV7();

  const migrateV8 = db.transaction(() => {
    const tableColumns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>).map((column) => column.name));
    const ledgerColumns = tableColumns("point_ledger");
    const hintColumns = tableColumns("purchased_hints");
    const hasColumns = (actual: Set<string>, expected: string[]) => expected.every((column) => actual.has(column));
    const ledgerIsV7 = hasColumns(ledgerColumns, ["id", "game_id", "player_id", "turn_id", "amount", "reason", "created_at"])
      && !ledgerColumns.has("question_id") && !ledgerColumns.has("hint_purchase_id");
    const ledgerIsV8 = hasColumns(ledgerColumns, ["id", "game_id", "player_id", "question_id", "hint_purchase_id", "amount", "reason", "created_at"])
      && !ledgerColumns.has("turn_id");
    const hintsHaveExpectedColumns = hasColumns(hintColumns, ["id", "game_id", "player_id", "hint_type", "hint_value", "cost", "purchased_at"]);
    const hintsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'purchased_hints'").get() as { sql: string } | null)?.sql ?? "";
    const hintsHaveKnownConstraint = /CHECK\s*\(\s*hint_type\s+IN\s*\(\s*'basic(?:_name)?'\s*,\s*'series'\s*,\s*'candidates'\s*\)\s*\)/i.test(hintsSql);
    const temporaryTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('point_ledger_v8', 'purchased_hints_v7', 'purchased_hints_v8') LIMIT 1").get();

    if (temporaryTables || !hintsHaveExpectedColumns || !hintsHaveKnownConstraint || (!ledgerIsV7 && !ledgerIsV8)) {
      throw new Error("Cannot migrate v7 economy: mixed or unrecognized partial schema state");
    }

    if (ledgerIsV8) {
      const invalidV8Rows = db.prepare(`
        SELECT pl.id
        FROM point_ledger pl
        LEFT JOIN questions q ON q.id = pl.question_id
        LEFT JOIN purchased_hints ph ON ph.id = pl.hint_purchase_id
        WHERE (pl.reason = 'answer_match' AND (pl.amount <= 0 OR pl.question_id IS NULL OR pl.hint_purchase_id IS NOT NULL OR q.id IS NULL))
           OR (pl.reason = 'hint_purchase' AND (pl.amount >= 0 OR pl.question_id IS NOT NULL OR pl.hint_purchase_id IS NULL OR ph.id IS NULL
               OR ph.game_id != pl.game_id OR ph.player_id != pl.player_id OR ph.cost != -pl.amount))
           OR pl.reason NOT IN ('answer_match', 'hint_purchase')
        LIMIT 1
      `).get();
      const invalidV8Hints = db.prepare(`
        SELECT ph.id FROM purchased_hints ph
        LEFT JOIN point_ledger pl ON pl.hint_purchase_id = ph.id AND pl.reason = 'hint_purchase'
        WHERE ph.hint_type NOT IN ('basic', 'basic_name', 'series', 'candidates') OR ph.cost <= 0 OR pl.id IS NULL
        LIMIT 1
      `).get();
      const inconsistentV8Balance = db.prepare(`
        SELECT pgs.player_id FROM player_game_state pgs
        LEFT JOIN point_ledger pl ON pl.game_id = pgs.game_id AND pl.player_id = pgs.player_id
        GROUP BY pgs.game_id, pgs.player_id, pgs.point_balance
        HAVING pgs.point_balance != COALESCE(SUM(pl.amount), 0)
        LIMIT 1
      `).get();
      if (invalidV8Rows || invalidV8Hints || inconsistentV8Balance) {
        throw new Error("Cannot advance v8 economy schema: existing data failed validation");
      }
      db.run("CREATE INDEX IF NOT EXISTS idx_purchased_hints_game_player ON purchased_hints(game_id, player_id, purchased_at);");
      db.run("CREATE INDEX IF NOT EXISTS idx_point_ledger_game_player ON point_ledger(game_id, player_id, created_at);");
      db.run("CREATE TRIGGER IF NOT EXISTS point_ledger_no_update BEFORE UPDATE ON point_ledger BEGIN SELECT RAISE(ABORT, 'point ledger is immutable'); END;");
      db.run("CREATE TRIGGER IF NOT EXISTS point_ledger_no_delete BEFORE DELETE ON point_ledger BEGIN SELECT RAISE(ABORT, 'point ledger is immutable'); END;");
      db.run("PRAGMA user_version = 8;");
      return;
    }

    const invalidAnswerLinks = db.prepare(`
      SELECT pl.id FROM point_ledger pl
      LEFT JOIN questions q ON q.turn_id = pl.turn_id
      WHERE pl.reason = 'answer_reward' AND (pl.amount <= 0 OR q.id IS NULL)
      LIMIT 1
    `).get();
    const invalidHintRows = db.prepare(`
      WITH ledger_ranked AS (
        SELECT id, game_id, player_id, created_at, amount,
               ROW_NUMBER() OVER (PARTITION BY game_id, player_id, created_at ORDER BY id) rank
        FROM point_ledger WHERE reason = 'hint_purchase'
      ), hint_ranked AS (
        SELECT id, game_id, player_id, purchased_at,
               ROW_NUMBER() OVER (PARTITION BY game_id, player_id, purchased_at ORDER BY id) rank
        FROM purchased_hints
      )
      SELECT l.id FROM ledger_ranked l
      LEFT JOIN hint_ranked h ON h.game_id = l.game_id AND h.player_id = l.player_id
        AND h.purchased_at = l.created_at AND h.rank = l.rank
      WHERE l.amount >= 0 OR h.id IS NULL
      UNION ALL
      SELECT h.id FROM hint_ranked h
      LEFT JOIN ledger_ranked l ON l.game_id = h.game_id AND l.player_id = h.player_id
        AND l.created_at = h.purchased_at AND l.rank = h.rank
      WHERE l.id IS NULL
      LIMIT 1
    `).get();
    const inconsistentBalance = db.prepare(`
      SELECT pgs.player_id FROM player_game_state pgs
      LEFT JOIN point_ledger pl ON pl.game_id = pgs.game_id AND pl.player_id = pgs.player_id
      GROUP BY pgs.game_id, pgs.player_id, pgs.point_balance
      HAVING pgs.point_balance != COALESCE(SUM(pl.amount), 0)
      LIMIT 1
    `).get();
    if (invalidAnswerLinks) throw new Error("Cannot migrate v7 economy: invalid or unmatched answer reward ledger row");
    if (invalidHintRows) throw new Error("Cannot migrate v7 economy: hint purchases and ledger rows cannot be paired one-to-one");
    if (inconsistentBalance) throw new Error("Cannot migrate v7 economy: point balance does not match ledger history");

    db.run(`
      CREATE TABLE purchased_hints_v8 (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        hint_type TEXT NOT NULL CHECK(hint_type IN ('basic', 'series', 'candidates')),
        hint_value TEXT NOT NULL,
        cost INTEGER NOT NULL CHECK(typeof(cost) = 'integer' AND cost > 0),
        purchased_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        UNIQUE(game_id, player_id, hint_type)
      );
      INSERT INTO purchased_hints_v8 (id, game_id, player_id, hint_type, hint_value, cost, purchased_at)
      SELECT id, game_id, player_id, CASE hint_type WHEN 'basic_name' THEN 'basic' ELSE hint_type END,
             hint_value, cost, purchased_at
      FROM purchased_hints;
      ALTER TABLE purchased_hints RENAME TO purchased_hints_v7;
      ALTER TABLE purchased_hints_v8 RENAME TO purchased_hints;
    `);
    db.run("DROP TRIGGER IF EXISTS point_ledger_no_update;");
    db.run("DROP TRIGGER IF EXISTS point_ledger_no_delete;");
    db.run(`
      CREATE TABLE point_ledger_v8 (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        question_id TEXT,
        hint_purchase_id TEXT,
        amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer'),
        reason TEXT NOT NULL CHECK(reason IN ('answer_match', 'hint_purchase')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE RESTRICT,
        FOREIGN KEY(hint_purchase_id) REFERENCES purchased_hints(id) ON DELETE RESTRICT,
        CHECK(
          (reason = 'answer_match' AND amount > 0 AND question_id IS NOT NULL AND hint_purchase_id IS NULL) OR
          (reason = 'hint_purchase' AND amount < 0 AND question_id IS NULL AND hint_purchase_id IS NOT NULL)
        ),
        UNIQUE(question_id, player_id, reason),
        UNIQUE(hint_purchase_id)
      );
    `);
    db.run(`
      WITH ledger_ranked AS (
        SELECT id, game_id, player_id, created_at,
               ROW_NUMBER() OVER (PARTITION BY game_id, player_id, created_at ORDER BY id) rank
        FROM point_ledger WHERE reason = 'hint_purchase'
      ), hint_ranked AS (
        SELECT id, game_id, player_id, purchased_at,
               ROW_NUMBER() OVER (PARTITION BY game_id, player_id, purchased_at ORDER BY id) rank
        FROM purchased_hints
      ), hint_pairs AS (
        SELECT l.id ledger_id, h.id hint_id FROM ledger_ranked l
        JOIN hint_ranked h ON h.game_id = l.game_id AND h.player_id = l.player_id
          AND h.purchased_at = l.created_at AND h.rank = l.rank
      )
      INSERT INTO point_ledger_v8 (id, game_id, player_id, question_id, hint_purchase_id, amount, reason, created_at)
      SELECT pl.id, pl.game_id, pl.player_id,
             CASE WHEN pl.reason = 'answer_reward' THEN q.id ELSE NULL END,
             CASE WHEN pl.reason = 'hint_purchase' THEN hp.hint_id ELSE NULL END,
             pl.amount,
             CASE WHEN pl.reason = 'answer_reward' THEN 'answer_match' ELSE 'hint_purchase' END,
             pl.created_at
      FROM point_ledger pl
      LEFT JOIN questions q ON q.turn_id = pl.turn_id
      LEFT JOIN hint_pairs hp ON hp.ledger_id = pl.id;
    `);
    db.run("DROP TABLE point_ledger;");
    db.run("DROP TABLE purchased_hints_v7;");
    db.run("ALTER TABLE point_ledger_v8 RENAME TO point_ledger;");
    db.run("CREATE INDEX idx_purchased_hints_game_player ON purchased_hints(game_id, player_id, purchased_at);");
    db.run("CREATE INDEX idx_point_ledger_game_player ON point_ledger(game_id, player_id, created_at);");
    db.run("CREATE TRIGGER point_ledger_no_update BEFORE UPDATE ON point_ledger BEGIN SELECT RAISE(ABORT, 'point ledger is immutable'); END;");
    db.run("CREATE TRIGGER point_ledger_no_delete BEFORE DELETE ON point_ledger BEGIN SELECT RAISE(ABORT, 'point ledger is immutable'); END;");
    db.run("PRAGMA user_version = 8;");
  });
  if (currentVersion < 8) migrateV8();

  const migrateV9 = db.transaction(() => {
    const gameColumns = db.prepare("PRAGMA table_info(games);").all() as Array<{ name: string }>;
    if (!gameColumns.some((column) => column.name === "state_revision")) {
      db.run("ALTER TABLE games ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision) = 'integer' AND state_revision >= 0);");
    }
    db.run(`
      CREATE TABLE player_game_state_v9 (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        assigned_character_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        character_series TEXT NOT NULL,
        character_image_url TEXT,
        character_description TEXT,
        turn_order INTEGER NOT NULL,
        has_guessed_correctly INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        point_balance INTEGER NOT NULL DEFAULT 0 CHECK(typeof(point_balance) = 'integer' AND point_balance >= 0),
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        UNIQUE(game_id, player_id),
        UNIQUE(game_id, assigned_character_id),
        UNIQUE(game_id, turn_order)
      );
      INSERT INTO player_game_state_v9 (
        id, game_id, player_id, assigned_character_id, character_name, character_series,
        character_image_url, character_description, turn_order, has_guessed_correctly, completed_at, point_balance
      )
      SELECT id, game_id, player_id, assigned_character_id, character_name, character_series,
             character_image_url, character_description, turn_order, has_guessed_correctly, completed_at,
             CASE WHEN typeof(point_balance) = 'integer' AND point_balance >= 0 THEN point_balance ELSE 0 END
      FROM player_game_state;
      DROP TABLE player_game_state;
      ALTER TABLE player_game_state_v9 RENAME TO player_game_state;
      CREATE INDEX idx_player_game_state_game ON player_game_state(game_id);
      CREATE INDEX idx_player_game_state_player ON player_game_state(player_id);
      CREATE TRIGGER game_revision_turn_insert AFTER INSERT ON game_turns BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      CREATE TRIGGER game_revision_turn_update AFTER UPDATE ON game_turns BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      CREATE TRIGGER game_revision_question_insert AFTER INSERT ON questions BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = (SELECT game_id FROM game_turns WHERE id = NEW.turn_id); END;
      CREATE TRIGGER game_revision_question_update AFTER UPDATE ON questions BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = (SELECT game_id FROM game_turns WHERE id = NEW.turn_id); END;
      CREATE TRIGGER game_revision_answer_insert AFTER INSERT ON turn_answers BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = (SELECT gt.game_id FROM questions q JOIN game_turns gt ON gt.id = q.turn_id WHERE q.id = NEW.question_id); END;
      CREATE TRIGGER game_revision_answer_update AFTER UPDATE ON turn_answers BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = (SELECT gt.game_id FROM questions q JOIN game_turns gt ON gt.id = q.turn_id WHERE q.id = NEW.question_id); END;
      CREATE TRIGGER game_revision_state_update AFTER UPDATE ON player_game_state BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      CREATE TRIGGER game_revision_hint_insert AFTER INSERT ON purchased_hints BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
    `);
    db.run("PRAGMA user_version = 9;");
  });
  if (currentVersion < 9) migrateV9();

  const migrateV10 = db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS guess_attempts (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        normalized_guess TEXT NOT NULL,
        display_guess TEXT NOT NULL,
        correct INTEGER NOT NULL CHECK(correct IN (0, 1)),
        attempted_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE RESTRICT,
        UNIQUE(game_id, player_id, normalized_guess)
      );
      CREATE INDEX IF NOT EXISTS idx_guess_attempts_game_player ON guess_attempts(game_id, player_id, attempted_at);
      PRAGMA user_version = 10;
    `);
  });
  if (currentVersion < 10) migrateV10();

  const migrateV11 = db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_turn_hint_purchases (
        turn_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        hint_purchase_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE RESTRICT,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY(hint_purchase_id) REFERENCES purchased_hints(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS ai_activity (
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        activity TEXT NOT NULL CHECK(activity IN ('thinking', 'answering', 'choosing_hint', 'asking', 'waiting', 'guessing')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(game_id, player_id),
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS ai_action_events (
        game_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('answered', 'hint_purchased', 'question_asked', 'guessed', 'passed')),
        outcome TEXT NOT NULL CHECK(outcome IN ('completed', 'correct', 'incorrect', 'fallback')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY(turn_id) REFERENCES game_turns(id) ON DELETE CASCADE
      );
      CREATE TRIGGER IF NOT EXISTS game_revision_ai_activity_insert AFTER INSERT ON ai_activity BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      CREATE TRIGGER IF NOT EXISTS game_revision_ai_activity_update AFTER UPDATE ON ai_activity BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      CREATE TRIGGER IF NOT EXISTS game_revision_ai_activity_delete AFTER DELETE ON ai_activity BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = OLD.game_id; END;
      CREATE TRIGGER IF NOT EXISTS game_revision_ai_action_insert AFTER INSERT ON ai_action_events BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      CREATE TRIGGER IF NOT EXISTS game_revision_ai_action_update AFTER UPDATE ON ai_action_events BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      PRAGMA user_version = 11;
    `);
  });
  if (currentVersion < 11) migrateV11();

  const migrateV12 = db.transaction(() => {
    const stateColumns = new Set((db.prepare("PRAGMA table_info(player_game_state);").all() as Array<{ name: string }>).map((column) => column.name));
    if (!stateColumns.has("character_snapshot_json")) db.run("ALTER TABLE player_game_state ADD COLUMN character_snapshot_json TEXT;");
    db.run(`
      UPDATE player_game_state SET character_snapshot_json = json_object(
        'id', assigned_character_id, 'name', character_name, 'series', character_series,
        'imageUrl', character_image_url, 'description', character_description
      ) WHERE character_snapshot_json IS NULL;
      CREATE TABLE IF NOT EXISTS character_cache (
        source TEXT NOT NULL,
        source_key TEXT NOT NULL,
        page_id INTEGER NOT NULL,
        normalized_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        PRIMARY KEY(source, source_key, page_id)
      );
      CREATE INDEX IF NOT EXISTS idx_character_cache_expiry ON character_cache(expires_at);
      PRAGMA user_version = 12;
    `);
  });
  if (currentVersion < 12) migrateV12();

  const migrateV13 = db.transaction(() => {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'purchased_hints'").get() as { sql: string } | null;
    if (!table) throw new Error("Cannot repair v13 economy: purchased_hints is missing");
    const hasLegacyConstraint = /basic_name/i.test(table.sql);
    const hasLegacyRows = Boolean(db.prepare("SELECT id FROM purchased_hints WHERE hint_type = 'basic_name' LIMIT 1").get());
    const hasCurrentConstraint = /CHECK\s*\(\s*hint_type\s+IN\s*\(\s*'basic'\s*,\s*'series'\s*,\s*'candidates'\s*\)\s*\)/i.test(table.sql);
    const invalid = db.prepare("SELECT id FROM purchased_hints WHERE hint_type NOT IN ('basic', 'basic_name', 'series', 'candidates') LIMIT 1").get();
    if (invalid) throw new Error("Cannot repair v13 economy: purchased_hints contains an invalid hint type");
    if (hasLegacyConstraint || hasLegacyRows || !hasCurrentConstraint) {
      db.run(`
        DROP TRIGGER IF EXISTS game_revision_hint_insert;
        CREATE TABLE purchased_hints_v13 (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          hint_type TEXT NOT NULL CHECK(hint_type IN ('basic', 'series', 'candidates')),
          hint_value TEXT NOT NULL,
          cost INTEGER NOT NULL CHECK(typeof(cost) = 'integer' AND cost > 0),
          purchased_at TEXT NOT NULL,
          FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
          UNIQUE(game_id, player_id, hint_type)
        );
        INSERT INTO purchased_hints_v13 (id, game_id, player_id, hint_type, hint_value, cost, purchased_at)
        SELECT id, game_id, player_id, CASE hint_type WHEN 'basic_name' THEN 'basic' ELSE hint_type END, hint_value, cost, purchased_at
        FROM purchased_hints;
        DROP TABLE purchased_hints;
        ALTER TABLE purchased_hints_v13 RENAME TO purchased_hints;
        CREATE INDEX idx_purchased_hints_game_player ON purchased_hints(game_id, player_id, purchased_at);
        CREATE TRIGGER game_revision_hint_insert AFTER INSERT ON purchased_hints BEGIN UPDATE games SET state_revision = state_revision + 1 WHERE id = NEW.game_id; END;
      `);
    }
    db.run("PRAGMA user_version = 13;");
  });
  if (currentVersion < 13) migrateV13();

  const migrateV14 = db.transaction(() => {
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>).map((column) => column.name));
    const roomColumns = columns("rooms");
    const gameColumns = columns("games");
    const questionColumns = columns("questions");
    const turnColumns = columns("game_turns");
    if (!roomColumns.has("answer_duration_seconds")) db.run("ALTER TABLE rooms ADD COLUMN answer_duration_seconds INTEGER NOT NULL DEFAULT 60 CHECK(typeof(answer_duration_seconds) = 'integer' AND answer_duration_seconds BETWEEN 15 AND 300);");
    if (!gameColumns.has("answer_duration_seconds")) db.run("ALTER TABLE games ADD COLUMN answer_duration_seconds INTEGER NOT NULL DEFAULT 60 CHECK(typeof(answer_duration_seconds) = 'integer' AND answer_duration_seconds BETWEEN 15 AND 300);");
    if (!questionColumns.has("answer_deadline_at")) db.run("ALTER TABLE questions ADD COLUMN answer_deadline_at TEXT;");
    if (!turnColumns.has("outcome")) db.run("ALTER TABLE game_turns ADD COLUMN outcome TEXT CHECK(outcome IN ('guessed', 'passed', 'skipped'));");
    db.run("UPDATE rooms SET answer_duration_seconds = 60 WHERE answer_duration_seconds IS NULL;");
    db.run("UPDATE games SET answer_duration_seconds = 60 WHERE answer_duration_seconds IS NULL;");
    db.run(`
      UPDATE questions SET answer_deadline_at = datetime(
        asked_at,
        '+' || COALESCE((SELECT g.answer_duration_seconds FROM game_turns gt JOIN games g ON g.id = gt.game_id WHERE gt.id = questions.turn_id), 60) || ' seconds'
      ) WHERE answer_deadline_at IS NULL;
    `);
    db.run("PRAGMA user_version = 14;");
  });
  if (currentVersion < 14) migrateV14();

  const migrateV15 = db.transaction(() => {
    db.run(`
      UPDATE questions
      SET answer_deadline_at = strftime(
        '%Y-%m-%dT%H:%M:%fZ',
        asked_at,
        '+' || COALESCE((
          SELECT g.answer_duration_seconds
          FROM game_turns gt JOIN games g ON g.id = gt.game_id
          WHERE gt.id = questions.turn_id
        ), 60) || ' seconds'
      );
      UPDATE game_turns
      SET outcome = 'guessed'
      WHERE outcome IS NULL AND EXISTS (SELECT 1 FROM guess_attempts ga WHERE ga.turn_id = game_turns.id);
      PRAGMA user_version = 15;
    `);
  });
  if (currentVersion < 15) migrateV15();

  const migrateV16 = db.transaction(() => {
    const columns = new Set((db.prepare("PRAGMA table_info(purchased_hints);").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("turn_id")) db.run("ALTER TABLE purchased_hints ADD COLUMN turn_id TEXT REFERENCES game_turns(id) ON DELETE CASCADE;");
    db.run(`
      UPDATE purchased_hints
      SET turn_id = (
        SELECT gt.id FROM game_turns gt
        WHERE gt.game_id = purchased_hints.game_id
          AND gt.active_player_id = purchased_hints.player_id
          AND gt.started_at <= purchased_hints.purchased_at
          AND (gt.ended_at IS NULL OR purchased_hints.purchased_at <= gt.ended_at)
        ORDER BY gt.started_at DESC, gt.turn_number DESC
        LIMIT 1
      )
      WHERE turn_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_purchased_hints_turn ON purchased_hints(turn_id, purchased_at);
      PRAGMA user_version = 16;
    `);
  });
  if (currentVersion < 16) migrateV16();

  db.run("DELETE FROM ai_activity;");
  
  db.run(`
    UPDATE questions
    SET moderator_status = 'failed', moderator_answer = NULL,
        moderator_error = 'Moderator evaluation interrupted by restart', moderator_claim_token = NULL,
        moderated_at = ?, moderator_revision = moderator_revision + 1
    WHERE moderator_status = 'pending' AND moderator_claim_token IS NOT NULL;
  `, [new Date().toISOString()]);

  // 2. Validate foreign keys outside the migration transaction and enable foreign keys
  const fkErrors = db.prepare("PRAGMA foreign_key_check;").all();
  if (fkErrors && fkErrors.length > 0) {
    throw new Error(`Foreign key constraint violation after migration: ${JSON.stringify(fkErrors)}`);
  }

  db.run("PRAGMA foreign_keys = ON;");

  // Reset stale connected states from prior runs
  db.run("UPDATE players SET connected = 0 WHERE connected != 0;");

  return db;
}
