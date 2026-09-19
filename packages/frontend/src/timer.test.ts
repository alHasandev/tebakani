import { describe, expect, it } from "bun:test";
import { createTimerClockReference, estimateServerNow, historyOutcomeText, secondsUntilDeadline, timerAnnouncementFor, timerAnnouncementText } from "./timer";

describe("synchronized timer calculations", () => {
  it("uses server offset and monotonic elapsed under positive and negative wall-clock skew", () => {
    const ahead = createTimerClockReference("2026-09-19T12:00:00.000Z", Date.parse("2026-09-19T12:05:00.000Z"), 1000);
    const behind = createTimerClockReference("2026-09-19T12:00:00.000Z", Date.parse("2026-09-19T11:55:00.000Z"), 1000);
    expect(estimateServerNow(ahead, 2500)).toBe(Date.parse("2026-09-19T12:00:01.500Z"));
    expect(estimateServerNow(behind, 2500)).toBe(Date.parse("2026-09-19T12:00:01.500Z"));
    expect(secondsUntilDeadline("2026-09-19T12:01:00.000Z", ahead, 2500)).toBe(59);
    expect(secondsUntilDeadline("2026-09-19T12:01:00.000Z", behind, 2500)).toBe(59);
  });

  it("announces threshold crossings once even when ticks skip exact values", () => {
    expect(timerAnnouncementFor(12, 9, false, false)).toBe("ten");
    expect(timerAnnouncementFor(9, 8, true, false)).toBeNull();
    expect(timerAnnouncementFor(1, 0, true, false)).toBe("timeout");
    expect(timerAnnouncementFor(0, 0, true, true)).toBeNull();
    expect(timerAnnouncementText("ten")).toBe("10 seconds remain to answer.");
    expect(timerAnnouncementText("timeout")).toBe("Answer time has ended.");
  });

  it("labels unknown legacy outcomes without inventing an outcome", () => {
    expect(historyOutcomeText("unknown")).toBe("Outcome unavailable for legacy turn");
    expect(historyOutcomeText("passed")).toBe("passed");
    expect(historyOutcomeText(null)).toBeNull();
  });
});
