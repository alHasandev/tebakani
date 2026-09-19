import type { AIModerator, ModerationRequest } from "../src/ai-moderator";
import type { AnswerValue } from "@tebakani/shared";

export class FakeModerator implements AIModerator {
  constructor(private readonly answer: AnswerValue = "maybe") {}

  async moderate(_request: ModerationRequest): Promise<AnswerValue> {
    return this.answer;
  }
}
