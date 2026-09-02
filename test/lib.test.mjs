import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guessMimeType, isAllowedSender, normalizeTelegramId, parseAllowedSenders, splitMessage, toTelegramChatId } from "../src/lib.mjs";

describe("Telegram helpers", () => {
  it("normalizes and filters sender IDs", () => { assert.equal(normalizeTelegramId("@alice"), "alice"); const allowed = parseAllowedSenders("123, @alice"); assert.equal(isAllowedSender("alice", allowed), true); assert.equal(isAllowedSender("999", allowed), false); });
  it("validates chat IDs", () => { assert.equal(toTelegramChatId("-100123"), "-100123"); assert.equal(toTelegramChatId("@alice"), "@alice"); assert.throws(() => toTelegramChatId(""), /to is required/); assert.throws(() => toTelegramChatId("hello"), /numeric chat ID/); });
  it("splits text and guesses MIME", () => { assert.deepEqual(splitMessage("a b c", 3), ["a b", "c"]); assert.equal(guessMimeType("x.PDF"), "application/pdf"); });
});
