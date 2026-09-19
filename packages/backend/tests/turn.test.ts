import { describe, it, expect } from "bun:test";
import { createApp } from "../src/app";
import { FakeModerator } from "./fake-moderator";

describe("Milestone 3 Turn Loop, Guessing, Answers, Concurrency & Completion", () => {
  it("atomically creates first turn in waiting_for_question on game start", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const host = repo.createRoom("HostPlayer");
    const guest = repo.joinRoom(host.room.code, "GuestPlayer");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    const startRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    expect(startRes.status).toBe(200);

    const gameRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    expect(gameRes.status).toBe(200);
    const game = await gameRes.json();

    expect(game.currentTurn).not.toBeNull();
    expect(game.currentTurn.turnNumber).toBe(1);
    expect(game.currentTurn.phase).toBe("waiting_for_question");
    expect(game.currentTurn.question).toBeNull();
    expect(game.currentTurn.activePlayerId).toBe(game.currentTurnPlayerId);
  });

  it("validates request payloads returning 400 for empty/malformed/too-long fields and requires characterName & expectedTurnId", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const host = repo.createRoom("ValHost");
    const guest = repo.joinRoom(host.room.code, "ValGuest");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );

    const gameRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    const game = await gameRes.json();
    const turnId = game.currentTurn.id;

    // Missing expectedTurnId
    const noTurnId = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
        body: JSON.stringify({ question: "Is my character human?" })
      })
    );
    expect(noTurnId.status).toBe(400);

    // Empty question
    const emptyQ = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, question: "   " })
      })
    );
    expect(emptyQ.status).toBe(400);

    // Question > 200 chars
    const longQ = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, question: "x".repeat(201) })
      })
    );
    expect(longQ.status).toBe(400);

    // Invalid answer value
    const badAns = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${guest.sessionToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, answer: "definitely" })
      })
    );
    expect(badAns.status).toBe(400);

    // Rejection of old { guess: "..." } field contract
    const oldContract = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, guess: "Goku" })
      })
    );
    expect(oldContract.status).toBe(400);

    // Guess > 100 chars
    const longGuess = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, characterName: "y".repeat(101) })
      })
    );
    expect(longGuess.status).toBe(400);

    // Stale expectedTurnId returns 409
    const staleTurn = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
        body: JSON.stringify({ expectedTurnId: "stale-turn-id-12345", question: "Valid question?" })
      })
    );
    expect(staleTurn.status).toBe(409);

    // Malformed JSON returns 400
    const malformedJson = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
        body: "not-a-json-string"
      })
    );
    expect(malformedJson.status).toBe(400);

    // Nonexistent route returns 404
    const notFoundRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/unknown-route`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    expect(notFoundRes.status).toBe(404);
  });

  it("handles question asking, answers upsert, and closing answers with permission checks", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const host = repo.createRoom("HostP");
    const guest = repo.joinRoom(host.room.code, "GuestP");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );

    const hostViewRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    const gameData = await hostViewRes.json();
    const turnId = gameData.currentTurn.id;
    const activePlayerId = gameData.currentTurn.activePlayerId;
    const activeToken = activePlayerId === host.player.id ? host.sessionToken : guest.sessionToken;
    const nonActiveToken = activePlayerId === host.player.id ? guest.sessionToken : host.sessionToken;

    // 1. Non-active player cannot ask question (403)
    const badAskRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${nonActiveToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Is my character male?" })
      })
    );
    expect(badAskRes.status).toBe(403);

    // 2. Active player asks valid question (200)
    const askRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Is my character male?" })
      })
    );
    expect(askRes.status).toBe(200);
    const afterAsk = await askRes.json();
    expect(afterAsk.currentTurn.phase).toBe("collecting_answers");
    expect(afterAsk.currentTurn.question.questionText).toBe("Is my character male?");

    // 3. Asking question again in same turn is rejected (409)
    const dupAskRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Second question?" })
      })
    );
    expect(dupAskRes.status).toBe(409);

    // 4. Active player cannot answer their own question (403)
    const selfAnswerRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId, answer: "yes" })
      })
    );
    expect(selfAnswerRes.status).toBe(403);

    // 5. Non-active player answers "yes"
    const ans1 = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${nonActiveToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId, answer: "yes" })
      })
    );
    expect(ans1.status).toBe(200);
    const ans1Data = await ans1.json();
    expect(ans1Data.currentTurn.question.answers).toHaveLength(1);
    expect(ans1Data.currentTurn.question.answers[0].answer).toBe("yes");

    // 6. Non-active player updates answer to "maybe" (upsert - still 1 row)
    const ans2 = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${nonActiveToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId, answer: "maybe" })
      })
    );
    expect(ans2.status).toBe(200);
    const ans2Data = await ans2.json();
    expect(ans2Data.currentTurn.question.answers).toHaveLength(1);
    expect(ans2Data.currentTurn.question.answers[0].answer).toBe("maybe");

    // 7. Non-active player cannot close answers (403)
    const badCloseRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${nonActiveToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId })
      })
    );
    expect(badCloseRes.status).toBe(403);

    // 8. Active player closes answers (200) -> transitions to awaiting_guess
    const closeRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ expectedTurnId: turnId })
      })
    );
    expect(closeRes.status).toBe(200);
    const closeData = await closeRes.json();
    expect(closeData.currentTurn.phase).toBe("awaiting_guess");

    // 9. Answering after answers are closed returns 409
    const afterCloseAns = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${nonActiveToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, answer: "no" })
      })
    );
    expect(afterCloseAns.status).toBe(409);
  });

  it("handles incorrect guess, pass, correct guess, circular turn advance skipping completed players, and finishing game", async () => {
    const { app, repo, db } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const host = repo.createRoom("HostG");
    const guest = repo.joinRoom(host.room.code, "GuestG");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );

    const game = repo.getRoomByCode(host.room.code);
    const gameRecord = db.prepare("SELECT id FROM games WHERE room_id = ?").get(game!.id) as any;
    const pgsList = db.prepare("SELECT player_id, character_name FROM player_game_state WHERE game_id = ?").all(gameRecord.id) as any[];

    // Check first active player
    let currentRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    let state = await currentRes.json();
    let turnId = state.currentTurn.id;
    let activePlayerId = state.currentTurn.activePlayerId;
    let activeToken = activePlayerId === host.player.id ? host.sessionToken : guest.sessionToken;

    // Phase to awaiting_guess: ask question -> close answers
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Am I human?" })
      })
    );
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId })
      })
    );

    // 1. Submit incorrect guess
    const wrongGuessRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, characterName: "TotallyWrongName123" })
      })
    );
    expect(wrongGuessRes.status).toBe(200);
    const wrongResult = await wrongGuessRes.json();
    expect(wrongResult.correct).toBe(false);
    // Viewer's own character is undefined in player roster
    const selfInWrongResult = wrongResult.game.players.find((p: any) => p.playerId === activePlayerId);
    expect(selfInWrongResult.character).toBeUndefined();

    // Turn advanced to other player!
    const otherPlayerId = activePlayerId === host.player.id ? guest.player.id : host.player.id;
    const otherToken = otherPlayerId === host.player.id ? host.sessionToken : guest.sessionToken;
    expect(wrongResult.game.currentTurn.activePlayerId).toBe(otherPlayerId);
    expect(wrongResult.game.currentTurn.turnNumber).toBe(2);
    expect(wrongResult.game.currentTurn.phase).toBe("waiting_for_question");

    const turn2Id = wrongResult.game.currentTurn.id;

    // 2. Other player passes turn: ask question -> close answers -> pass
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn2Id, question: "Is my character strong?" })
      })
    );
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn2Id })
      })
    );

    const passRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/pass`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn2Id })
      })
    );
    expect(passRes.status).toBe(200);
    const afterPass = await passRes.json();
    expect(afterPass.currentTurn.activePlayerId).toBe(activePlayerId);
    expect(afterPass.currentTurn.turnNumber).toBe(3);

    const turn3Id = afterPass.currentTurn.id;

    // 3. First player makes CORRECT normalized guess (trimmed, mixed case)
    const firstCharName = pgsList.find((p) => p.player_id === activePlayerId).character_name;
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turn3Id, question: "Am I " + firstCharName + "?" })
      })
    );
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turn3Id })
      })
    );

    const correctGuessRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turn3Id, characterName: "  " + firstCharName.toUpperCase() + "  " })
      })
    );
    expect(correctGuessRes.status).toBe(200);
    const correctResult = await correctGuessRes.json();
    expect(correctResult.correct).toBe(true);

    // Inspect first player's view: because they guessed correctly, their OWN character is now revealed!
    const firstPlayerSelfView = correctResult.game.players.find((p: any) => p.playerId === activePlayerId);
    expect(firstPlayerSelfView.hasGuessedCorrectly).toBe(true);
    expect(firstPlayerSelfView.completedAt).not.toBeNull();
    expect(firstPlayerSelfView.character).toBeDefined();
    expect(firstPlayerSelfView.character.name).toBe(firstCharName);

    // Game is still playing because other player hasn't guessed
    expect(correctResult.game.status).toBe("playing");
    expect(correctResult.game.currentTurn.activePlayerId).toBe(otherPlayerId);

    const turn4Id = correctResult.game.currentTurn.id;

    // Completed first player cannot ask a question if turn reaches them (completed player blocked)
    const completedAsk = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turn4Id, question: "Another question?" })
      })
    );
    expect(completedAsk.status).toBe(403);

    // 4. Completed first player CAN answer other player's question
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn4Id, question: "Final question" })
      })
    );

    const completedAnswer = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turn4Id, answer: "yes" })
      })
    );
    expect(completedAnswer.status).toBe(200);
    const ansData = await completedAnswer.json();
    const storedAns = ansData.currentTurn.question.answers.find((a: any) => a.playerId === activePlayerId);
    expect(storedAns).toBeDefined();
    expect(storedAns.answer).toBe("yes");

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn4Id })
      })
    );

    // Second player guesses correctly -> Game finishes!
    const secondCharName = pgsList.find((p) => p.player_id === otherPlayerId).character_name;
    const finalGuessRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn4Id, characterName: secondCharName })
      })
    );
    expect(finalGuessRes.status).toBe(200);
    const finalResult = await finalGuessRes.json();
    expect(finalResult.correct).toBe(true);
    expect(finalResult.game.status).toBe("finished");
    expect(finalResult.game.finishedAt).not.toBeNull();
    expect(finalResult.game.currentTurnPlayerId).toBeNull();
    expect(finalResult.game.currentTurn).toBeNull();

    // Verify zero active turns in database
    const remainingActiveTurns = db.prepare("SELECT * FROM game_turns WHERE game_id = ? AND is_active = 1").all(gameRecord.id);
    expect(remainingActiveTurns).toHaveLength(0);
  });

  it("advances 3+ player game circularly skipping completed players", async () => {
    const { app, repo, db } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const p1 = repo.createRoom("Player1");
    const p2 = repo.joinRoom(p1.room.code, "Player2");
    const p3 = repo.joinRoom(p1.room.code, "Player3");
    expect(p2.status).toBe("success");
    expect(p3.status).toBe("success");
    if (p2.status !== "success" || p3.status !== "success") return;

    await app.handle(
      new Request(`http://localhost/rooms/${p1.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p1.sessionToken}` }
      })
    );

    const room = repo.getRoomByCode(p1.room.code)!;
    const game = db.prepare("SELECT id FROM games WHERE room_id = ?").get(room.id) as any;
    const pgs = db.prepare("SELECT * FROM player_game_state WHERE game_id = ? ORDER BY turn_order ASC").all(game.id) as any[];

    // Mark player with turn_order 1 as completed directly in DB
    const skippedPlayerId = pgs[1].player_id;
    db.prepare("UPDATE player_game_state SET has_guessed_correctly = 1 WHERE id = ?").run(pgs[1].id);

    const gameRes = await app.handle(
      new Request(`http://localhost/rooms/${p1.room.code}/game`, {
        headers: { Authorization: `Bearer ${p1.sessionToken}` }
      })
    );
    const gameData = await gameRes.json();
    const turnId = gameData.currentTurn.id;
    const turn0PlayerId = pgs[0].player_id;
    const token0 = [p1, p2, p3].find((p) => (p as any).player?.id === turn0PlayerId || (p as any).player?.id === turn0PlayerId)!.sessionToken;

    // Advance turn 0 by passing
    await app.handle(
      new Request(`http://localhost/rooms/${p1.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token0}` },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Skip test question" })
      })
    );
    await app.handle(
      new Request(`http://localhost/rooms/${p1.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token0}` },
        body: JSON.stringify({ expectedTurnId: turnId })
      })
    );
    const passRes = await app.handle(
      new Request(`http://localhost/rooms/${p1.room.code}/game/pass`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token0}` },
        body: JSON.stringify({ expectedTurnId: turnId })
      })
    );
    expect(passRes.status).toBe(200);
    const afterPass = await passRes.json();

    // Turn must have skipped player order 1 and advanced to player order 2!
    expect(afterPass.currentTurn.activePlayerId).toBe(pgs[2].player_id);
    expect(afterPass.currentTurn.activePlayerId).not.toBe(skippedPlayerId);
  });

  it("handles concurrent duplicate skip with consecutive AI players giving one 200 and one 409, and exactly one active turn", async () => {
    const { app, repo, db } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const host = repo.createRoom("HostAiConsecutive");
    const ai1 = repo.joinRoom(host.room.code, "Bot1", "ai");
    const ai2 = repo.joinRoom(host.room.code, "Bot2", "ai");
    expect(ai1.status).toBe("success");
    expect(ai2.status).toBe("success");
    if (ai1.status !== "success" || ai2.status !== "success") return;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );

    const room = repo.getRoomByCode(host.room.code)!;
    const game = db.prepare("SELECT id FROM games WHERE room_id = ?").get(room.id) as any;

    // Arrange turn order so active turn is an AI player
    const gameRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    let gameData = await gameRes.json();
    let turnId = gameData.currentTurn.id;

    if (gameData.currentTurn.activePlayerType !== "ai") {
      // Pass host turn so turn reaches AI
      await app.handle(
        new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
          body: JSON.stringify({ expectedTurnId: turnId, question: "Host question" })
        })
      );
      await app.handle(
        new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
          body: JSON.stringify({ expectedTurnId: turnId })
        })
      );
      const passed = await app.handle(
        new Request(`http://localhost/rooms/${host.room.code}/game/pass`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
          body: JSON.stringify({ expectedTurnId: turnId })
        })
      );
      gameData = await passed.json();
      turnId = gameData.currentTurn.id;
    }

    expect(gameData.currentTurn.activePlayerType).toBe("ai");

    // Concurrently issue two skip-ai-turn requests sharing the same expectedTurnId
    const [resSkip1, resSkip2] = await Promise.all([
      app.handle(
        new Request(`http://localhost/rooms/${host.room.code}/game/skip-ai-turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
          body: JSON.stringify({ expectedTurnId: turnId })
        })
      ),
      app.handle(
        new Request(`http://localhost/rooms/${host.room.code}/game/skip-ai-turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.sessionToken}` },
          body: JSON.stringify({ expectedTurnId: turnId })
        })
      )
    ]);

    const statuses = [resSkip1.status, resSkip2.status].sort();
    // One succeeds (200), the other receives 409 because expectedTurnId is now stale!
    expect(statuses).toEqual([200, 409]);

    // Verify exactly one active turn exists in database
    const activeTurns = db.prepare("SELECT * FROM game_turns WHERE game_id = ? AND is_active = 1").all(game.id);
    expect(activeTurns).toHaveLength(1);
  });

  it("handles concurrent guess and pass ensuring exactly one advancement", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const host = repo.createRoom("RacerHost");
    const guest = repo.joinRoom(host.room.code, "RacerGuest");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );

    const gameRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    const game = await gameRes.json();
    const turnId = game.currentTurn.id;
    const activeToken = game.currentTurn.activePlayerId === host.player.id ? host.sessionToken : guest.sessionToken;

    // Advance to awaiting_guess
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Racing question" })
      })
    );
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId })
      })
    );

    // Concurrently issue guess and pass
    const [resGuess, resPass] = await Promise.all([
      app.handle(
        new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
          body: JSON.stringify({ expectedTurnId: turnId, characterName: "SomeGuess" })
        })
      ),
      app.handle(
        new Request(`http://localhost/rooms/${host.room.code}/game/pass`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
          body: JSON.stringify({ expectedTurnId: turnId })
        })
      )
    ]);

    const statuses = [resGuess.status, resPass.status].sort();
    // One succeeded (200), one got conflict (409)
    expect(statuses).toEqual([200, 409]);
  });
});
