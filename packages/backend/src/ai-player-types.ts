import type { AnswerValue, CharacterKnowledge, HintType, PurchasedHint, TurnPhase } from "@tebakani/shared";

export type GameActor =
  | Readonly<{ kind: "human"; playerId: string }>
  | Readonly<{ kind: "ai"; playerId: string }>;

export interface AIPlayerSelfContext {
  player: { id: string; name: string; pointBalance: number };
  game: { id: string; roomCode: string; turnId: string; turnNumber: number; phase: TurnPhase };
  evidence: Array<{ question: string; moderatorAnswer: AnswerValue }>;
  previousGuesses: Array<{ characterName: string; correct: false }>;
  purchasedHints: PurchasedHint[];
  availableHintTypes: HintType[];
  economy: Record<HintType, number>;
}

export interface AIPlayerAnswerContext {
  answeringPlayer: { id: string; name: string };
  game: { id: string; turnId: string; questionId: string };
  question: string;
  target: {
    playerId: string;
    playerName: string;
    character: { id: string; name: string; series: string; imageUrl?: string; description?: string; knowledge?: CharacterKnowledge };
  };
}

export type AIHintDecision = { action: "none" } | { action: "purchase"; type: HintType };
export type AIGuessDecision = { action: "pass" } | { action: "guess"; characterName: string };

export interface AIPlayerAgent {
  answerQuestion(context: Readonly<AIPlayerAnswerContext>, signal?: AbortSignal): Promise<AnswerValue>;
  decideHint(context: Readonly<AIPlayerSelfContext>, signal?: AbortSignal): Promise<AIHintDecision>;
  generateQuestion(context: Readonly<AIPlayerSelfContext>, signal?: AbortSignal): Promise<string>;
  decideGuessOrPass(context: Readonly<AIPlayerSelfContext>, signal?: AbortSignal): Promise<AIGuessDecision>;
}
