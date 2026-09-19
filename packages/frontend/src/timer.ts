export interface TimerClockReference {
  serverEpochMs: number;
  receivedWallMs: number;
  receivedMonotonicMs: number;
}

export function createTimerClockReference(serverTime: string, wallNow = Date.now(), monotonicNow = performance.now()): TimerClockReference {
  return { serverEpochMs: Date.parse(serverTime), receivedWallMs: wallNow, receivedMonotonicMs: monotonicNow };
}

export function estimateServerNow(reference: TimerClockReference, monotonicNow = performance.now()): number {
  return reference.serverEpochMs + Math.max(0, monotonicNow - reference.receivedMonotonicMs);
}

export function secondsUntilDeadline(deadline: string, reference: TimerClockReference, monotonicNow = performance.now()): number {
  return Math.max(0, Math.ceil((Date.parse(deadline) - estimateServerNow(reference, monotonicNow)) / 1000));
}

export function timerAnnouncementFor(previousSeconds: number | null, seconds: number, announcedTen: boolean, announcedTimeout: boolean): "ten" | "timeout" | null {
  if (!announcedTimeout && seconds <= 0 && (previousSeconds === null || previousSeconds > 0)) return "timeout";
  if (!announcedTen && seconds <= 10 && seconds > 0 && (previousSeconds === null || previousSeconds > 10)) return "ten";
  return null;
}

export function timerAnnouncementText(announcement: "ten" | "timeout"): string {
  return announcement === "ten" ? "10 seconds remain to answer." : "Answer time has ended.";
}

export function historyOutcomeText(outcome: "guessed" | "passed" | "skipped" | "unknown" | null): string | null {
  if (outcome === "unknown") return "Outcome unavailable for legacy turn";
  return outcome;
}
