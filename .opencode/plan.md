# Plan: Milestone 6 — Autonomous AI Players

## Objective

Evolve TebakAni’s existing server-managed AI players into autonomous participants that answer questions, earn and spend points, take normal turns, buy legitimate hints, ask questions, guess or pass, recover after restart, and remain subject to the same authoritative game rules as humans. Preserve all Milestones 1–5 behavior, authentication, hidden-character secrecy, viewer-specific serialization, scoring, and concurrency guarantees.

## Requirements Snapshot

- **R1 — Preserve architecture:** Extend the existing Bun/Elysia, Svelte 5, SQLite, REST/WebSocket, game-service, economy, hint, and moderator implementation. Do not create a parallel AI-only engine.
- **R2 — Absolute self-secrecy:** AIPlayerAgent and all provider-facing self contexts must exclude the AI player’s own assignment ID, character name, description, image, and series unless SERIES was legitimately purchased. CANDIDATES may expose names but never a correct marker.
- **R3 — Visibility separation:** Build distinct self-reasoning and other-player-answer contexts. An AI answering another player may receive that target’s visible character metadata; an active AI must never receive its own hidden character through context reuse.
- **R4 — Trusted actor model:** Add explicit human and internal-AI actors. REST remains human-session authenticated; no fake AI sessions or client-selectable `actAsAI` mechanism. AI actors must resolve to real AI players in the relevant game.
- **R5 — Shared domain actions:** AI question, answer, hint, close, guess, and pass actions must use GameService/domain enforcement, expected turn IDs, phase checks, scoring, point costs, completion, and advancement rules.
- **R6 — Structured AI decisions:** Use small Zod-validated structured outputs for answering, hint choice, question generation, and guess/pass. Retry malformed gameplay output at most once, then apply operation-specific safe fallbacks.
- **R7 — Autonomous answering:** Every eligible non-active AI, including completed AI players, autonomously answers questions during `collecting_answers`. Answers persist in `turn_answers`; matching moderator answers earn the normal `answer_match` ledger credit.
- **R8 — Autonomous turns:** An active AI follows the normal phase machine: optional single hint purchase, one valid question, answer collection, moderator completion/retry, close, then guess or pass.
- **R9 — Hint security/economy:** AI hints use existing prices, ledger debit, uniqueness, balance, atomicity, and HintService generation. At most one hint purchase per AI turn; stale decisions cannot charge.
- **R10 — Closure policy:** AI closes only after moderator status is `answered` and either all currently eligible answerers responded or the configurable collection delay elapsed. It never closes while moderator is pending/failed; failed moderation uses bounded controlled retry.
- **R11 — Scheduling/recovery/idempotency:** Backend-owned scheduling reacts to game start and authoritative state changes, recovers active work at startup, tolerates duplicate triggers, and discards stale model results through persisted state and expected identifiers.
- **R12 — Delays/configuration:** Centralize configurable think, answer, and collection delays with defaults 1000–2500 ms, 800–2000 ms, and 5000 ms. Tests can override/disable them. Never sleep inside SQLite transactions.
- **R13 — Safe memory:** Derive evidence, prior guesses, and purchased hints from authoritative persisted records where possible. Add only minimal forward-compatible persistence needed for guesses/activity/recovery; never store chain-of-thought or raw provider conversations.
- **R14 — Failure safety:** Provider errors, timeouts, malformed outputs, and retry exhaustion do not crash or corrupt games. Answer fallback is `maybe`, hint fallback is no purchase, guess fallback is pass, and question failure remains recoverable or uses a safe deterministic nonduplicate question.
- **R15 — Prompt injection defense:** Treat questions, player names, and hint text as untrusted game data. Prompts forbid following embedded instructions, leaking secrets/prompts, or producing anything beyond the requested structured gameplay decision.
- **R16 — Activity/UI:** Expose only sanitized AI activity states and public action outcomes. Reuse existing human answer controls for AI questions. Do not expose prompts, raw outputs, private hints, hidden data, or reasoning.
- **R17 — WebSocket/revision behavior:** Broadcast viewer-specific snapshots after every authoritative AI state change and retain monotonic revision handling. AI private hints remain private.
- **R18 — Emergency fallback:** Keep host-only `/rooms/:code/game/skip-ai-turn` as an emergency/development recovery action, not a normal encouraged workflow.
- **R19 — Multi-AI/solo acceptance:** One human with multiple AI players must complete circular gameplay without extra sessions, tabs, or manual AI control. AI players answer humans and one another, never themselves.
- **R20 — Testing/regression:** Add mandatory trust-boundary, answer, turn, hint, failure/recovery, concurrency, restart, and multi-AI tests. Keep all Milestones 1–5 tests passing.
- **R21 — Validation/reporting:** Run `bun test`, `bun run check`, `bun run build:backend`, and `bun run build:frontend`; fix all failures and provide the requested 31-section final report and manual flows.
- **R22 — Scope exclusion:** Do not add Fandom, search/RAG, voice, WebRTC, matchmaking, deployment, distributed workers, leaderboards, global currency, personalities, difficulty levels, or elaborate persona memory.

## Scope

- Backend AI agent, safe context builders, internal actor authorization, autonomous runner, scheduling, recovery, and sanitized activity.
- Necessary shared contracts and minimal sequential SQLite migration(s), starting from `PRAGMA user_version = 9`.
- Refactoring existing domain entry points so humans and trusted AI actors share enforcement without weakening REST authentication.
- Frontend visualization of autonomous activity and public AI actions using the existing game view and answer controls.
- Full automated coverage and validation, including all existing regressions.

## Assumptions and Constraints

- Existing authoritative tables remain the source of truth: `games`, `player_game_state`, `game_turns`, `questions`, `turn_answers`, `point_ledger`, and `purchased_hints`.
- Existing question and guess limits remain 200 and 100 characters respectively.
- Existing answer upsert/unique constraints and immutable ledger protections remain intact.
- SQLite and an in-process runner are sufficient; distributed workers and multi-instance coordination are out of scope.
- AI LLM calls use the existing Vercel AI SDK and OpenAI-compatible provider infrastructure.
- Exact new persistence should be decided after mapping what can be derived. A likely minimal migration is needed for safe guess history and optionally persisted activity timestamps; durable queued jobs are unnecessary if startup recovery derives work from game state.
- Tests should inject fake AI agents, deterministic clocks/delays, and fake moderators rather than call a provider.

## Risks and Areas Requiring Care

- The current `GameRepository.getPlayerGameStates()` returns hidden character metadata for every player. Passing this entity or a normal serialized view into self reasoning would violate the core trust boundary.
- Current repository methods explicitly reject AI question, answer, and hint actions. Refactoring must distinguish trusted actor authorization without permitting clients to forge AI identity.
- `closeAnswers()` currently validates active player identity in GameService and settles directly. The AI closure path must retain moderator readiness, expected turn protection, and one-time settlement.
- Existing `turn_answers` upsert allows later replacement. Runner scheduling must avoid duplicate model calls where practical and revalidate state before upsert so stale results cannot alter closed/new turns.
- Delayed work and startup recovery can trigger the same action concurrently. In-memory dedupe improves efficiency, but database state and conditional writes must remain the correctness boundary.
- AI activity updates can produce excessive revisions or stale statuses. Clear activity in `finally`, validate turn ownership, and define startup normalization.
- Guess history is not currently persisted. Incorrect guesses must become durable without revealing the actual character.
- Current hint eligibility requires `type = human` and phases `collecting_answers`/`awaiting_guess`; the desired AI lifecycle evaluates hints before asking. Eligibility must be deliberately expanded to an active AI in `waiting_for_question` while preserving existing human behavior unless product rules explicitly allow humans there too.
- Synchronous fake timers and background microtasks can make tests flaky. Runner lifecycle must expose deterministic drain/shutdown hooks.

## Core Concepts

### Trusted actor boundary

REST resolves only human actors from bearer sessions. The runner constructs AI actors internally after querying the game membership and player type.

```ts
type GameActor =
  | { kind: "human"; playerId: string }
  | { kind: "ai"; playerId: string };
```

Each GameService action validates the actor against the target game. Repository transactions receive the validated actor or an explicit trusted kind, then independently recheck player membership/type, active turn, phase, and `expectedTurnId` before mutation. No route accepts `kind` from request data.

### Safe context construction

Self context is an allowlist assembled from non-secret columns and safe derived history, never by deleting fields from `PlayerGameStateEntity`.

```ts
interface AIPlayerSelfContext {
  player: { id: string; name: string; pointBalance: number };
  game: { id: string; turnId: string; turnNumber: number; phase: TurnPhase };
  evidence: Array<{ question: string; moderatorAnswer: AnswerValue }>;
  previousGuesses: Array<{ characterName: string; correct: false }>;
  purchasedHints: PurchasedHint[];
  economy: typeof ECONOMY.hintCosts;
}
```

Other-player answer context is built separately and includes only the target player’s visible character data plus the untrusted question.

### State-derived idempotency

Every delayed/model action captures `(gameId, turnId, questionId?, playerId)`. Immediately before mutation, shared domain methods atomically verify those identifiers and required phase. Stale results return a benign no-op classification to the runner or raise a recognized stale-domain error; they never reopen phases or advance twice.

## Sub-Tasks

### Sub-Task 1: Baseline Mapping and Regression Safety

- **Status:** Pending
- **Objective:** Establish a verified baseline and exact dependency map before changing shared domain behavior.
- **Related Requirements:** R1, R20, R21
- **Dependencies and Preconditions:** Existing repository at schema version 9.
- **In Scope for This Sub-Task:**
  - Inspect all backend services/repositories, migration pipeline, shared contracts, App.svelte, and test helpers.
  - Record current test count, assertion count if Bun reports it, TypeScript/build state, and any pre-existing failures.
  - Map all callers of `askQuestion`, `submitAnswer`, `closeAnswers`, `submitGuess`, `passTurn`, `purchaseHint`, moderator retry, and game-start/turn-advance paths.
  - Identify every serialization path that can expose character or hint data.
- **Out of Scope for This Sub-Task:** Any feature implementation or schema change.
- **Instructions:** Run baseline commands through the executor; do not treat pre-existing failures as Milestone 6 regressions without documenting them.
- **Acceptance Criteria:** Existing behavior and affected call sites are documented for implementation; baseline command outcomes are known.
- **Cautionary Points (Risks & Edge Cases):** The root is a workspace; verify root scripts rather than assuming package-local commands.
- **Implementation Suggestions:** Use current app factory return values and fake moderator patterns as test seams.
- **Testing Suggestions:** Run `bun test`, `bun run check`, `bun run build:backend`, `bun run build:frontend`.
- **Done When:** Baseline results and change surface are available and no code has changed.

### Sub-Task 2: Shared Contracts, AI Configuration, and Test Seams

- **Status:** Pending
- **Objective:** Define stable types and centralized configuration for AI decisions, activity, delays, retry limits, and safe contexts.
- **Related Requirements:** R2, R3, R6, R10, R12, R14, R16
- **Dependencies and Preconditions:** Sub-Task 1 complete.
- **In Scope for This Sub-Task:**
  - Add shared/public AI activity types only where frontend serialization needs them.
  - Add backend-only decision/context types where clients must not see them.
  - Extend environment/config loading with defaulted non-secret delay settings and bounded retry settings.
  - Add injectable delay/random/clock configuration to keep tests immediate and deterministic.
  - Extend `.env.example` with gameplay configuration, never credentials in tests or logs.
- **Out of Scope for This Sub-Task:** Agent prompts, runner implementation, or database mutation.
- **Instructions:** Centralize defaults in one module; validate integer ranges; avoid scattering constants.
- **Acceptance Criteria:** All AI timing/retry behavior is represented by typed configuration and can be overridden to zero in tests.
- **Cautionary Points (Risks & Edge Cases):** Production AI initialization is lazy today; adding optional delay settings must not make tests require provider environment variables.
- **Implementation Suggestions:** Separate required provider config from gameplay defaults if necessary so fake-agent tests remain isolated.
- **Testing Suggestions:** Unit-test defaults, valid overrides, and invalid negative/noninteger values.
- **Done When:** Configuration and contracts compile with no behavior change.

### Sub-Task 3: Minimal Persistence and Migration

- **Status:** Pending
- **Objective:** Add only persistence that cannot be safely derived from existing authoritative records.
- **Related Requirements:** R11, R13, R16, R20
- **Dependencies and Preconditions:** Sub-Task 2 types finalized.
- **In Scope for This Sub-Task:**
  - Add a sequential migration from version 9.
  - Persist AI guess attempts with game/player/turn, normalized/display guess, correctness, and timestamp; enforce uniqueness adequate to prevent repeating the same normalized wrong guess.
  - Decide whether activity must persist. Prefer derivable/in-memory activity unless restart-visible status requires a small table/columns; if persisted, store only sanitized enum, scoped identifiers, and timestamps.
  - Add repository read/write APIs for safe guess history and activity, with conditional updates.
  - Ensure migration preserves existing data and is idempotently applied once.
- **Out of Scope for This Sub-Task:** AI summaries, chain-of-thought, prompts, raw outputs, durable provider payloads, or a generic jobs table without demonstrated need.
- **Instructions:** Keep existing records authoritative. Question evidence comes from `questions`; hints from `purchased_hints`; answers and scoring from existing tables.
- **Acceptance Criteria:** Upgrading a version-9 database retains all rows and reaches the new exact `PRAGMA user_version`; fresh DB schema matches upgraded schema.
- **Cautionary Points (Risks & Edge Cases):** Guess persistence and turn advancement must be atomic or otherwise ordered so restart cannot lose the attempt while advancing.
- **Implementation Suggestions:** Integrate guess-attempt insert into `submitGuessAtomic`; store no actual character in the new table.
- **Testing Suggestions:** Extend migration tests for 9-to-new upgrade, fresh creation, constraints, and immutable existing ledger triggers.
- **Done When:** Minimal durable history exists and migration tests pass.

### Sub-Task 4: Internal Actor Model and Shared Domain Enforcement

- **Status:** Pending
- **Objective:** Permit trusted AI actions through the same domain paths while preserving human authentication and all game rules.
- **Related Requirements:** R4, R5, R7, R8, R9, R18
- **Dependencies and Preconditions:** Sub-Task 3 schema/repositories available.
- **In Scope for This Sub-Task:**
  - Introduce `GameActor` internally and helpers that validate membership and expected player type.
  - Refactor GameService methods to use actor-aware internal entry points while keeping route-facing signatures human-safe or wrapping them explicitly as human actors.
  - Update turn repository transactions to allow AI only when the actor kind is internally validated.
  - Allow completed AI players to answer others, matching current completed-human behavior.
  - Preserve self-answer prohibition, active-player rules, phase checks, and expected-turn checks.
  - Expand hint eligibility for active AI in the intended pre-question phase and existing valid phases; enforce actual AI type and membership.
  - Keep skip-AI host-only and label it in code/UI as emergency/development fallback.
- **Out of Scope for This Sub-Task:** Any public REST actor selector, AI bearer token, fake session, or direct runner SQL mutation.
- **Instructions:** Routes must construct only human actors after current bearer validation. AI actors must be constructed only by runner-owned code.
- **Acceptance Criteria:** The same action methods enforce both human and AI behavior; an external request cannot forge an AI actor; AI actions cannot target another room/game.
- **Cautionary Points (Risks & Edge Cases):** Avoid relying only on TypeScript discriminants for trust. Repository transactions must verify persisted type/membership.
- **Implementation Suggestions:** Return explicit stale/no-op outcomes for runner calls where benign races are expected, while preserving existing REST error semantics.
- **Testing Suggestions:** Add service/repository tests for forged type, wrong game, wrong phase, stale turn, self-answer, and unchanged human endpoint authentication.
- **Done When:** Trusted AI actors can exercise normal domain operations and REST security is unchanged.

### Sub-Task 5: Safe Context Builders and AI Memory Views

- **Status:** Pending
- **Objective:** Build compact, explicit, testable contexts for self reasoning and answering other players without secret crossover.
- **Related Requirements:** R2, R3, R13, R15, R20
- **Dependencies and Preconditions:** Sub-Tasks 3–4 complete.
- **In Scope for This Sub-Task:**
  - Add `AIPlayerSelfContextBuilder` using allowlisted SQL/repository projections that never materialize the self character assignment.
  - Include player identity/name/balance, turn metadata, authoritative moderator evidence, optional bounded secondary human answers, prior incorrect guesses, legitimate purchased hints, and economy prices.
  - Apply compact history limits while retaining nonduplicate authoritative evidence and all relevant wrong guesses/hints.
  - Add a separate `AIPlayerAnswerContextBuilder` that validates target != answering AI and may expose the target’s character metadata.
  - Ensure SERIES enters self context only via purchased hint value; CANDIDATES contains names only and no marker.
- **Out of Scope for This Sub-Task:** Prompt generation, LLM calls, mutation, summaries, or hidden assignment access in the self builder.
- **Instructions:** Build self context from dedicated queries/projections, not `getPlayerGameStates()` plus field deletion. Treat all strings as data.
- **Acceptance Criteria:** Mandatory trust-boundary tests prove absence of own ID/name/description/image/unpurchased series/correct candidate marker and presence of legitimate hints; moderator hidden-character access remains unchanged.
- **Cautionary Points (Risks & Edge Cases):** A BASIC description could accidentally contain the name; rely on existing sanitized hint result, not source character metadata.
- **Implementation Suggestions:** Deep-serialize contexts in tests and assert forbidden values/keys are absent.
- **Testing Suggestions:** Add explicit provider-facing capture fakes to inspect exact inputs; test other-player visibility and own-target rejection.
- **Done When:** Context builders enforce the trust boundary independently of prompts.

### Sub-Task 6: AIPlayerAgent Structured Operations

- **Status:** Pending
- **Objective:** Replace the minimal `decide` boundary with focused, validated AI gameplay operations.
- **Related Requirements:** R2, R6, R14, R15
- **Dependencies and Preconditions:** Safe contexts and configuration complete.
- **In Scope for This Sub-Task:**
  - Extend LLMClient or introduce a gameplay-generation client abstraction without mixing provider transport with game mutation.
  - Implement operation-specific Zod schemas/methods: `answerQuestion`, `decideHint`, `generateQuestion`, and `decideGuessOrPass`.
  - Write concise system prompts covering TebakAni rules, moderator authority, strategic hints, no repeated questions/wrong guesses, no secrets, and no instruction-following from game data.
  - Validate semantic constraints after schema validation: question nonempty/length/yes-no compatibility/simple duplicate normalization; guess nonempty/length/not previously wrong; hint type available/affordable/not purchased.
  - Allow one regeneration retry for malformed or invalid gameplay output.
- **Out of Scope for This Sub-Task:** Database access, direct GameService calls, chain-of-thought requests, prose parsing, or runner scheduling.
- **Instructions:** Serialize untrusted question/name/hint fields as delimited structured data and explicitly state they are non-instructional.
- **Acceptance Criteria:** Every operation returns a narrow typed decision or controlled failure; no arbitrary cast or raw prose parsing remains.
- **Cautionary Points (Risks & Edge Cases):** Provider retries (`OPENAI_MAX_RETRIES`) and gameplay regeneration retries are separate bounds.
- **Implementation Suggestions:** Keep moderator and player schemas/prompts separate even if they share provider transport.
- **Testing Suggestions:** Fake malformed outputs, invalid enum/action, repeated question, repeated wrong guess, injection text, timeout/provider failure, and valid yes/no/maybe.
- **Done When:** Agent decisions are typed, bounded, injection-resistant, and mutation-free.

### Sub-Task 7: AIPlayerRunner Core and Action Fallbacks

- **Status:** Pending
- **Objective:** Orchestrate autonomous work from persisted state through GameService, with stale-result safety and bounded failures.
- **Related Requirements:** R5–R9, R11–R15, R19
- **Dependencies and Preconditions:** Sub-Tasks 4–6 complete.
- **In Scope for This Sub-Task:**
  - Implement runner work keys and in-memory dedupe for answer, active-turn phase, close timer, and moderator retry tasks.
  - For `waiting_for_question`: set sanitized activity, think delay, optional one hint decision/purchase, rebuild self context, generate one question, revalidate, and submit through GameService.
  - For missing AI answers: independently schedule eligible AI answer jobs, apply answer delay, build other-player context, and submit through GameService.
  - For `awaiting_guess`: build fresh context, decide guess/pass, reject repeated normalized wrong guess with one bounded regeneration or pass, and call normal guess/pass actions.
  - Apply fallbacks: answer `maybe`; hint no-op; guess pass; question deterministic safe nonduplicate fallback or recoverable delayed retry.
  - Log only safe identifiers/action/result class and sanitized errors.
  - Clear activity in success, stale, and failure paths.
- **Out of Scope for This Sub-Task:** Direct SQL mutation, provider output broadcasting, distributed locks, or unlimited retries.
- **Instructions:** Delay before model work, never in a DB transaction. Re-read state before every domain mutation. Catch stale/closed phase as benign.
- **Acceptance Criteria:** Duplicate runner invocation cannot duplicate authoritative effects; stale outputs are discarded; provider failures leave a valid recoverable game.
- **Cautionary Points (Risks & Edge Cases):** Multiple AI answers should run concurrently only after per-player keys prevent duplicate work. Correctness outranks parallelism.
- **Implementation Suggestions:** Expose `drain()` and `stop()`/timer cleanup for tests and app shutdown. Inject sleep/random/agent/logger.
- **Testing Suggestions:** Test duplicate execution, stale turn after model delay, provider failure fallbacks, answer values, one-hint-per-turn, and no duplicate charge/score/advance.
- **Done When:** Runner can safely perform each isolated AI action through GameService.

### Sub-Task 8: Collection Closure and Moderator Recovery

- **Status:** Pending
- **Objective:** Ensure active AI turns leave `collecting_answers` without waiting forever and without bypassing moderator/scoring rules.
- **Related Requirements:** R7, R8, R10, R11, R14
- **Dependencies and Preconditions:** Runner core available.
- **In Scope for This Sub-Task:**
  - Add repository/service queries for eligible answerer count, answered count, moderator status, question timestamp, and configured deadline.
  - Close immediately when moderator answered and all eligible participants answered; otherwise schedule closure at the remaining collection delay.
  - Revalidate moderator answered and active AI/turn/question before settlement.
  - When moderator failed on an active AI turn, invoke the existing controlled retry mechanism internally with a separate bounded attempt policy.
  - Never close on pending/failed moderator and never reopen closed collection.
- **Out of Scope for This Sub-Task:** Changing manual human closure behavior or requiring every human to answer.
- **Instructions:** Define eligible participants consistently: all game players except active asker; completed players remain eligible.
- **Acceptance Criteria:** AI waits while moderator pending, retries boundedly after failure, closes after all answers or timeout, and settles exactly once.
- **Cautionary Points (Risks & Edge Cases):** Question timestamps use wall clock; tests need an injected clock/timer. Late answers racing closure must either commit before settlement or be rejected after phase transition.
- **Implementation Suggestions:** Schedule one deadline per turn/question key and let domain state decide on wake-up.
- **Testing Suggestions:** Cover all-answered early close, timeout close, pending/failed no-close, retry success/exhaustion, answer-close race, and duplicate timers.
- **Done When:** AI collecting phase is autonomous and deadlock-resistant.

### Sub-Task 9: State-Change Scheduling and Startup Recovery

- **Status:** Pending
- **Objective:** Trigger autonomous work after every relevant authoritative transition and resume it after process restart.
- **Related Requirements:** R11, R17, R19
- **Dependencies and Preconditions:** Runner and closure logic complete.
- **In Scope for This Sub-Task:**
  - Add one central “reconcile game” entry point that inspects persisted state and schedules all currently possible AI work.
  - Invoke reconciliation after game start, human/AI question submission, answer persistence, moderator success/failure, close, hint, guess/pass, and turn advancement.
  - On app startup, list active games and reconcile waiting AI turns, unanswered AI jobs, closable collections, failed moderator work, and AI awaiting guess.
  - Retain current moderator pending recovery and integrate it with unified reconciliation.
  - Ensure app factory exposes deterministic startup/recovery drain hooks for tests.
- **Out of Scope for This Sub-Task:** Browser-triggered run-AI endpoints, polling by clients, or distributed worker leadership.
- **Instructions:** Reconciliation should be cheap, state-based, and safe to call repeatedly. Avoid callback cycles by relying on dedupe plus phase checks.
- **Acceptance Criteria:** No WebSocket connection or special client action is required; restart resumes each recoverable state without duplication.
- **Cautionary Points (Risks & Edge Cases):** `queueMicrotask` startup behavior can race test setup. Make recovery scheduling observable and controllable.
- **Implementation Suggestions:** Runner action-completion callback can broadcast then reconcile; domain services should not depend directly on Elysia.
- **Testing Suggestions:** Reopen a file-backed DB in each recoverable phase, start a new app instance, drain tasks, and assert exactly one resulting action.
- **Done When:** Autonomous gameplay progresses from server state alone before and after restart.

### Sub-Task 10: Sanitized Activity, Serialization, and WebSocket Broadcasts

- **Status:** Pending
- **Objective:** Expose safe AI status/action visibility while preserving viewer-specific secrecy and revision ordering.
- **Related Requirements:** R2, R16, R17
- **Dependencies and Preconditions:** Runner scheduling complete.
- **In Scope for This Sub-Task:**
  - Add sanitized AI activity to shared game contracts and viewer serialization if needed.
  - Associate activity with player/turn and clear or ignore stale activity after advancement/restart/failure.
  - Broadcast viewer-specific `game_state`/`game_finished` snapshots after authoritative AI answer, hint, question, moderator update, close, guess/pass, completion, and advancement.
  - Preserve private `ownHints` behavior so only the AI’s internal context receives its hints; human clients never receive AI private hints.
  - Preserve monotonic `state_revision`; if activity is public and persisted, ensure activity transitions increment revision safely.
- **Out of Scope for This Sub-Task:** Raw model result, prompt, hidden assignment, provider request/error, chain-of-thought, or private hint broadcast.
- **Instructions:** Prefer status enums and public action records already inferable from turn state. Do not serialize internal contexts.
- **Acceptance Criteria:** Captured WebSocket and REST snapshots contain no forbidden self data and display current AI status without stale overwrite.
- **Cautionary Points (Risks & Edge Cases):** AI has no socket/topic consumer, but per-human serialization must still avoid exposing AI-owned private hints.
- **Implementation Suggestions:** Keep existing message types when possible; add fields to `GameView` rather than raw event payloads so reconnect gets current state.
- **Testing Suggestions:** Extend WS tests for revision ordering, activity sanitation, multiple viewers, private hints, and action broadcasts.
- **Done When:** Clients receive enough safe state to visualize autonomy, with no secrecy regression.

### Sub-Task 11: Frontend Autonomous AI UX

- **Status:** Pending
- **Objective:** Visualize AI activity and public outcomes while reusing the current game interaction UI.
- **Related Requirements:** R16–R19
- **Dependencies and Preconditions:** Shared contracts and backend serialization stable.
- **In Scope for This Sub-Task:**
  - Display labels such as `AI Player · Thinking…`, answering, choosing a question, waiting, analyzing, guessing, passing, and sanitized error/recovery state.
  - Show AI-authored questions in the existing current-turn question area.
  - Keep normal Yes/No/Maybe controls available to eligible humans when an AI asks.
  - Show public guess/pass outcome if represented by game state/history.
  - De-emphasize/relabel Skip AI Turn as emergency/development fallback.
  - Keep revision-based merge protection.
- **Out of Scope for This Sub-Task:** Chain-of-thought UI, private AI hints, separate AI answer UI, personalities, or redesign of the whole frontend.
- **Instructions:** Match existing Svelte 5 rune and styling patterns. Use the modern web guidance skill before client-side UI edits and Context7 for current Svelte/library specifics.
- **Acceptance Criteria:** A single human browser can observe and participate through AI turns without manual AI control; no secret/provider content appears.
- **Cautionary Points (Risks & Edge Cases):** Disable only actions prohibited by phase/identity; do not accidentally prevent humans from answering an AI question.
- **Implementation Suggestions:** Extract small components only if they remove real duplication; avoid broad App.svelte restructuring.
- **Testing Suggestions:** Run Svelte/TypeScript checks and frontend build; manually exercise human-active and AI-active states.
- **Done When:** Autonomous behavior is understandable and human participation remains unchanged.

### Sub-Task 12: Comprehensive Automated Tests

- **Status:** Pending
- **Objective:** Implement all mandatory Milestone 6 test categories with deterministic fake agents and zero delays.
- **Related Requirements:** R2–R21
- **Dependencies and Preconditions:** Backend and frontend features complete.
- **In Scope for This Sub-Task:**
  - Add fake/scripted AI agent utilities that capture exact contexts and return queued structured decisions/errors.
  - Trust-boundary tests for every forbidden field/value, legitimate SERIES/CANDIDATES behavior, moderator hidden access, other-player visibility, logs/state/WS/provider inputs.
  - AI answer tests: eligibility, self/outside-phase rejection, completed AI, persistence, duplicate/stale execution, yes/no/maybe, matching/nonmatching score, normal ledger reason.
  - AI turn tests: automatic start, valid question, normal persistence/phases, human/other-AI answers, moderator wait/retry, close policy, settlement, guess/pass, incorrect secrecy/advance, correct completion/skip.
  - AI hint tests: no hint, all types, funds, duplicate type, normal debit, nonnegative balance, safe result, one-per-turn, stale decision.
  - Failure/recovery tests: provider/malformed output, all fallbacks, restart states, duplicate scheduling, no duplicate advancement/scoring/charge.
  - Multi-AI room test with one human and three AI players through circular progression and eventual finish using scripted decisions.
  - Preserve and update existing tests only where contracts intentionally gained fields.
- **Out of Scope for This Sub-Task:** Live provider integration tests or nondeterministic sleeps.
- **Instructions:** Keep test fixtures explicit and assert persisted rows, not only HTTP status. Use file-backed temporary DBs for restart tests and clean them up.
- **Acceptance Criteria:** Every mandatory scenario in prompt sections 41–46 has an explicit passing assertion; Milestones 1–5 suites remain intact.
- **Cautionary Points (Risks & Edge Cases):** An “eventually finish” script must avoid infinite turns and keep assignment-independent correct-guess tests from leaking assignments into the AI agent context; the test harness may inspect DB separately to script outcomes, but captured provider self context must remain clean.
- **Implementation Suggestions:** Split tests by concern (`ai-player-context`, `ai-runner`, `ai-recovery`, `ai-multi`) to keep files maintainable.
- **Testing Suggestions:** Run focused files during implementation, then full `bun test`.
- **Done When:** Required coverage is explicit, deterministic, and green.

### Sub-Task 13: Full Validation, Security Review, and Final Report

- **Status:** Pending
- **Objective:** Verify correctness, security, scope, builds, and documentation before declaring Milestone 6 complete.
- **Related Requirements:** R1–R22
- **Dependencies and Preconditions:** All implementation and tests complete.
- **In Scope for This Sub-Task:**
  - Review the diff for hidden-character flow, logs, serialization, actor forgery, raw errors, and direct runner DB writes.
  - Run all required validation commands exactly.
  - Record tests passed/failed, assertion count when available, TypeScript/Svelte outcomes, and backend/frontend build outcomes.
  - Confirm final schema version and migration behavior.
  - Execute or document manual Flows A–F with exact setup, expected state changes, and safe observability points.
  - Produce the requested 31-section final report: summary, files, dependencies, DB, architecture, trust boundary, flows, recovery, security, concurrency, APIs, frontend, tests, validation, manual instructions, and limitations.
- **Out of Scope for This Sub-Task:** Milestone 7 or any excluded integration.
- **Instructions:** Do not report completion if any required command fails. Use a final reviewer pass and executor-run validation.
- **Acceptance Criteria:** `bun test`, `bun run check`, `bun run build:backend`, and `bun run build:frontend` all exit successfully; report contains no unsupported claims.
- **Cautionary Points (Risks & Edge Cases):** Ensure test process exits cleanly with no orphan timers. Redact environment values and provider payloads from output.
- **Implementation Suggestions:** Use Git diff/change analysis to list exact files and identify missed tests.
- **Testing Suggestions:** Required commands plus targeted manual run with delays enabled and one restart using a file-backed DB.
- **Done When:** Validation is fully green, the report is complete, and work stops before Milestone 7.

## Final Integration & Verification

- **System-Wide Test:** Run a deterministic one-human/three-AI game using scripted agents through question, answer, scoring, hint, close, guess/pass, completion, and restart; verify all provider-facing self contexts remain free of own hidden character metadata and all client snapshots remain viewer-safe.
- **Completion Checklist:**
  - [ ] Human REST authentication and session behavior unchanged.
  - [ ] No endpoint accepts AI identity or fake AI sessions.
  - [ ] AIPlayerAgent cannot access SQLite or mutate domain state.
  - [ ] Self context is allowlisted and contains no own assignment metadata.
  - [ ] Other-player context is separate and target visibility is intentional.
  - [ ] Structured outputs and bounded retries cover every AI operation.
  - [ ] AI answers persist and score through normal ledger settlement.
  - [ ] AI hints charge normal prices and remain private.
  - [ ] AI follows the existing phase machine and expected-turn checks.
  - [ ] Closure waits for moderator and uses all-answered/timeout policy.
  - [ ] Incorrect guesses reveal nothing and cannot be repeated.
  - [ ] Duplicate/stale jobs are harmless.
  - [ ] Startup recovery resumes every recoverable state.
  - [ ] Delays are centralized, configurable, and disabled in tests.
  - [ ] Activity/logs/WS expose no prompts, outputs, reasoning, or secrets.
  - [ ] Emergency skip remains host-only and de-emphasized.
  - [ ] One-human/three-AI acceptance flow works without extra clients.
  - [ ] Migration upgrades version 9 and preserves data.
  - [ ] All old and new tests pass.
  - [ ] Type checks and both builds pass.
  - [ ] Final report includes all 31 requested sections.
  - [ ] No Milestone 7 or excluded feature implemented.

## Open Questions

- No blocking product question. During implementation, choose the smallest persistence design that supports durable wrong-guess history and safe restart behavior. Prefer state-derived scheduling over a durable jobs table.
- The final `PRAGMA user_version` depends on whether one migration is sufficient. Keep migrations sequential and report the actual final value.
