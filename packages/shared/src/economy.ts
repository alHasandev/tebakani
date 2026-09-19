export const ECONOMY = {
  correctAnswerPoints: 1,
  hintCosts: {
    basic: 1,
    series: 2,
    candidates: 3
  }
} as const;

export type HintType = keyof typeof ECONOMY.hintCosts;
