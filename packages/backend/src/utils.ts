import { randomBytes } from "crypto";

// Unambiguous uppercase character set: excluded 0, O, 1, I, L
const UNAMBIGUOUS_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateRoomCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += UNAMBIGUOUS_CHARS[bytes[i] % UNAMBIGUOUS_CHARS.length];
  }
  return code;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}
