import type { HintType } from "./economy";

export { ECONOMY } from "./economy";
export type { HintType } from "./economy";

export type PlayerType = "human" | "ai";

export interface Player {
  id: string;
  roomId: string;
  name: string;
  type: PlayerType;
  isHost: boolean;
  connected: boolean;
  createdAt: string;
}

export interface Room {
  id: string;
  code: string;
  createdAt: string;
}

export interface LobbyState {
  room: Room;
  players: Player[];
}

export interface CreateRoomRequest {
  playerName: string;
  playerType?: PlayerType;
}

export interface JoinRoomRequest {
  playerName: string;
  playerType?: PlayerType;
}

export interface AuthSessionResponse {
  room: Room;
  player: Player;
  sessionToken: string;
}

export interface CharacterKnowledge {
  aliases?: string[];
  gender?: string;
  species?: string;
  affiliations?: string[];
  abilities?: string[];
  occupation?: string[];
  status?: string;
  notableTraits?: string[];
}

export interface CharacterSummary {
  id: string;
  name: string;
  series: string;
  imageUrl?: string;
  description?: string;
  source?: "local" | "fandom";
  sourceKey?: string;
  sourceUrl?: string;
  knowledge?: CharacterKnowledge;
}

export interface CharacterSource {
  getCharacterById(id: string): Promise<CharacterSummary | null>;
  getRandomCharacters(count: number): Promise<CharacterSummary[]>;
  getCharactersBySeries?(series: string, count: number): Promise<CharacterSummary[]>;
  searchCharacters?(query: string, options?: { series?: string; limit?: number }): Promise<CharacterSummary[]>;
}

// Milestone 2 & 3 Game contracts
export type GameStatus = "lobby" | "playing" | "finished";

export type TurnPhase = "waiting_for_question" | "collecting_answers" | "awaiting_guess";

export type AnswerValue = "yes" | "no" | "maybe";
export type ModeratorStatus = "pending" | "answered" | "failed";

export interface TurnAnswerView {
  playerId: string;
  playerName: string;
  answer: AnswerValue;
  answeredAt: string;
}

export interface TurnPointAwardView {
  playerId: string;
  amount: number;
}

export interface TurnQuestionView {
  id: string;
  questionText: string;
  askedAt: string;
  moderatorStatus: ModeratorStatus;
  moderatorAnswer: AnswerValue | null;
  moderatorRevision: number;
  answers: TurnAnswerView[];
  awards: TurnPointAwardView[];
}

export interface CurrentTurnView {
  id: string;
  gameId: string;
  turnNumber: number;
  activePlayerId: string;
  activePlayerName: string;
  activePlayerType: PlayerType;
  phase: TurnPhase;
  question: TurnQuestionView | null;
  startedAt: string;
}

export interface PointLedgerEntry {
  id: string;
  questionId: string | null;
  hintPurchaseId: string | null;
  amount: number;
  reason: "answer_match" | "hint_purchase";
  createdAt: string;
}

export interface PurchasedHint {
  id: string;
  type: HintType;
  value: string | string[];
  cost: number;
  purchasedAt: string;
}

export interface GamePlayerStateView {
  playerId: string;
  playerName: string;
  playerType: PlayerType;
  turnOrder: number;
  isCurrentTurn: boolean;
  connected: boolean;
  hasGuessedCorrectly: boolean;
  completedAt: string | null;
  pointBalance: number;
  // Own character is omitted until hasGuessedCorrectly is true; other players' characters are always included
  character?: CharacterSummary;
}

export type AIActivityStatus = "thinking" | "answering" | "choosing_hint" | "asking" | "waiting" | "guessing";
export type AIActionType = "answered" | "hint_purchased" | "question_asked" | "guessed" | "passed";
export interface AIActivityView { playerId: string; turnId: string; status: AIActivityStatus; updatedAt: string }
export interface AIActionView { playerId: string; turnId: string; action: AIActionType; outcome: "completed" | "correct" | "incorrect" | "fallback"; createdAt: string }

export interface GameView {
  id: string;
  roomId: string;
  roomCode: string;
  status: GameStatus;
  revision: number;
  currentTurnPlayerId: string | null;
  currentTurn: CurrentTurnView | null;
  players: GamePlayerStateView[];
  ownLedger: PointLedgerEntry[];
  ownHints: PurchasedHint[];
  aiActivity: AIActivityView[];
  lastAIAction: AIActionView | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AskQuestionRequest {
  expectedTurnId: string;
  question: string;
}

export interface SubmitAnswerRequest {
  expectedTurnId: string;
  answer: AnswerValue;
}

export interface CloseAnswersRequest {
  expectedTurnId: string;
}

export interface SubmitGuessRequest {
  expectedTurnId: string;
  characterName: string;
}

export interface PassTurnRequest {
  expectedTurnId: string;
}

export interface SkipAiTurnRequest {
  expectedTurnId: string;
}

export interface RetryModeratorRequest {
  expectedTurnId: string;
}

export interface PurchaseHintRequest {
  expectedTurnId: string;
  type: HintType;
}

export interface PurchaseHintResponse {
  hint: PurchasedHint;
  game: GameView;
}

export interface AddAIPlayerRequest {
  players: Array<{ name: string | null }>;
}

export interface GuessResultResponse {
  correct: boolean;
  game: GameView;
}

export type WsServerMessage =
  | { type: "lobby_update"; data: LobbyState }
  | { type: "game_started"; data: GameView }
  | { type: "game_state"; data: GameView }
  | { type: "game_finished"; data: GameView }
  | { type: "error"; error: string };
