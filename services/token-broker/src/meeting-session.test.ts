import { describe, expect, it } from "vitest";
import { MeetingSessionRegistry, normalizeMeetingUrl, peekMeetingToken } from "./meeting-session.js";

function reg(now = { t: 1_000_000 }) {
  return { reg: new MeetingSessionRegistry("test-secret-at-least-16-bytes", () => now.t), now };
}

describe("MeetingSessionRegistry tokens", () => {
  it("issues and verifies a bot_page token bound to a session", () => {
    const { reg: r } = reg();
    const s = r.create({ meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui", mode: "output_media" });
    const tok = r.issue(s.id, "bot_page", { brokerPublicUrl: "https://broker.example" });
    const v = r.verify(tok, { role: "bot_page" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.sid).toBe(s.id);
      expect(v.payload.role).toBe("bot_page");
      expect(v.payload.brk).toBe("https://broker.example");
      expect(v.payload.exp - v.payload.iat).toBe(15 * 60_000);
    }
    expect(peekMeetingToken(tok)?.sid).toBe(s.id);
  });
  it("rejects malformed, tampered and foreign-secret tokens", () => {
    const { reg: r } = reg();
    const s = r.create({ meetingUrl: "https://meet.google.com/a-b-c", botName: "Yui", mode: "output_media" });
    const tok = r.issue(s.id, "client");
    expect(r.verify("garbage").ok).toBe(false);
    expect(r.verify("garbage")).toMatchObject({ reason: "malformed" });
    const [body, sig] = tok.split(".") as [string, string];
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), role: "relay" })).toString("base64url");
    expect(r.verify(`${tampered}.${sig}`)).toMatchObject({ ok: false, reason: "bad_signature" });
    const other = new MeetingSessionRegistry("another-secret-0123456789", () => 1_000_000);
    expect(other.verify(tok)).toMatchObject({ ok: false, reason: "bad_signature" });
  });
  it("expires: bot_page ≤ 15 min, client 60 min, relay 6 h", () => {
    const { reg: r, now } = reg();
    const s = r.create({ meetingUrl: "https://zoom.us/j/1", botName: "Yui", mode: "relay" });
    const page = r.issue(s.id, "bot_page", { ttlMs: 60 * 60_000 }); // asks for more → clamped to 15 min
    const client = r.issue(s.id, "client");
    const relay = r.issue(s.id, "relay");
    now.t += 15 * 60_000;
    expect(r.verify(page)).toMatchObject({ ok: false, reason: "expired" });
    expect(r.verify(client).ok).toBe(true);
    now.t += 45 * 60_000;
    expect(r.verify(client)).toMatchObject({ ok: false, reason: "expired" });
    expect(r.verify(relay).ok).toBe(true);
    now.t += 6 * 60 * 60_000;
    expect(r.verify(relay)).toMatchObject({ ok: false, reason: "expired" });
  });
  it("enforces role", () => {
    const { reg: r } = reg();
    const s = r.create({ meetingUrl: "https://zoom.us/j/1", botName: "Yui", mode: "relay" });
    const relay = r.issue(s.id, "relay");
    expect(r.verify(relay, { role: "client" })).toMatchObject({ ok: false, reason: "wrong_role" });
    expect(r.verify(relay, { role: ["client", "relay"] }).ok).toBe(true);
  });
  it("binds botId ↔ session and rejects mismatches", () => {
    const { reg: r } = reg();
    const s = r.create({ meetingUrl: "https://zoom.us/j/1", botName: "Yui", mode: "relay" });
    const pre = r.issue(s.id, "relay"); // issued before the bot exists (payload.bot = "")
    r.bindBot(s.id, "bot42");
    expect(r.verify(pre, { botId: "bot42" }).ok).toBe(true);
    expect(r.verify(pre, { botId: "botX" })).toMatchObject({ ok: false, reason: "bot_mismatch" });
    const post = r.issue(s.id, "client");
    expect(peekMeetingToken(post)?.bot).toBe("bot42");
    expect(r.byBot("bot42")?.id).toBe(s.id);
    // A token whose bot field disagrees with the registry (forged binding) fails even with a valid signature.
    const other = r.create({ meetingUrl: "https://zoom.us/j/2", botName: "Yui", mode: "relay" });
    r.bindBot(other.id, "bot99");
    const otherTok = r.issue(other.id, "client");
    expect(r.verify(otherTok, { botId: "bot42" })).toMatchObject({ ok: false, reason: "bot_mismatch" });
  });
  it("bot_page activation is single-use (replay → 401 semantics)", () => {
    const { reg: r } = reg();
    const s = r.create({ meetingUrl: "https://meet.google.com/a-b-c", botName: "Yui", mode: "output_media" });
    const tok = r.issue(s.id, "bot_page");
    expect(r.activateBotPage(tok).ok).toBe(true);
    expect(r.activateBotPage(tok)).toMatchObject({ ok: false, reason: "replayed" });
    expect(s.activations).toBe(1);
    expect(s.botPageActivatedAt).toBe(1_000_000);
    // A refreshed token (new nonce) activates again — that's the operator's explicit choice.
    const fresh = r.issue(s.id, "bot_page");
    expect(r.activateBotPage(fresh).ok).toBe(true);
    expect(s.activations).toBe(2);
  });
  it("revoke and end invalidate every token immediately", () => {
    const { reg: r } = reg();
    const s = r.create({ meetingUrl: "https://meet.google.com/a-b-c", botName: "Yui", mode: "output_media" });
    const tok = r.issue(s.id, "client");
    expect(r.revoke(s.id)).toBe(true);
    expect(r.verify(tok)).toMatchObject({ ok: false, reason: "revoked" });
    const s2 = r.create({ meetingUrl: "https://meet.google.com/x-y-z", botName: "Yui", mode: "output_media" });
    const tok2 = r.issue(s2.id, "relay");
    r.end(s2.id, "call_ended/bot_received_leave_call");
    expect(r.verify(tok2)).toMatchObject({ ok: false, reason: "ended" });
    expect(r.revoke("nope")).toBe(false);
  });
  it("unknown session (swept) → unknown_session", () => {
    const { reg: r, now } = reg();
    const s = r.create({ meetingUrl: "https://meet.google.com/a-b-c", botName: "Yui", mode: "output_media" });
    const tok = r.issue(s.id, "client");
    r.end(s.id, "done");
    now.t += 5 * 60_000;
    expect(r.sweep()).toEqual([s.id]);
    expect(r.verify(tok)).toMatchObject({ ok: false, reason: "unknown_session" });
  });
  it("sweeps idle live sessions after 6 h and keeps active ones", () => {
    const { reg: r, now } = reg();
    const a = r.create({ meetingUrl: "https://meet.google.com/a-b-c", botName: "Yui", mode: "output_media" });
    const b = r.create({ meetingUrl: "https://meet.google.com/d-e-f", botName: "Yui", mode: "output_media" });
    now.t += 5 * 60 * 60_000;
    r.touch(b.id);
    now.t += 61 * 60_000;
    expect(r.sweep()).toEqual([a.id]);
    expect(r.size()).toBe(1);
  });
  it("duplicate join detection normalises the meeting URL", () => {
    const { reg: r } = reg();
    const s = r.create({ meetingUrl: "https://meet.google.com/abc-defg-hij/", botName: "Yui", mode: "output_media" });
    expect(r.findActiveByMeetingUrl("https://MEET.google.com/abc-defg-hij?authuser=0")?.id).toBe(s.id);
    r.end(s.id, "left");
    expect(r.findActiveByMeetingUrl("https://meet.google.com/abc-defg-hij")).toBeUndefined();
    expect(normalizeMeetingUrl("not a url")).toBe("not a url");
  });
  it("uses an ephemeral secret when none is configured", () => {
    const r1 = new MeetingSessionRegistry(undefined);
    const r2 = new MeetingSessionRegistry("short");
    expect(r1.secretSource).toBe("ephemeral");
    expect(r2.secretSource).toBe("ephemeral");
    const s = r1.create({ meetingUrl: "https://zoom.us/j/1", botName: "Yui", mode: "relay" });
    expect(r1.verify(r1.issue(s.id, "client")).ok).toBe(true);
  });
});
