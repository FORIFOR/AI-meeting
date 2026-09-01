import { describe, expect, it } from "vitest";
import { authorizeWebSocketUpgrade } from "../meeting-ws-auth.js";
import { MeetingSessionRegistry } from "../meeting-session.js";
import { RelayHub } from "../meeting-relay.js";

/**
 * Attendee wants one socket per stream type. Only the mixed one is bidirectional — it is how the
 * character's voice leaves — so the stream has to be identifiable at the upgrade, or a per-participant
 * socket connecting last would be registered as the vendor and swallow every reply.
 */
describe("per-participant relay sockets", () => {
  function setup() {
    const sessions = new MeetingSessionRegistry("s".repeat(32));
    const relay = new RelayHub("https://broker.example");
    const session = sessions.create({ meetingUrl: "https://meet.google.com/x", botName: "Yui", mode: "relay" });
    sessions.bindBot(session.id, "bot_1");
    const token = sessions.issue(session.id, "relay");
    relay.register(token);
    relay.bind(token, "bot_1");
    return { sessions, relay, token };
  }

  for (const [path, stream] of [
    ["audio", "mixed"],
    ["participant-audio", "participant_audio"],
    ["participant-video", "participant_video"],
  ] as const) {
    it(`identifies the ${stream} stream`, () => {
      const { sessions, relay, token } = setup();
      const auth = authorizeWebSocketUpgrade(`/api/meeting/attendee/${path}/${encodeURIComponent(token)}/`, sessions, relay);
      expect(auth.ok).toBe(true);
      if (auth.ok && auth.kind === "relay") {
        expect(auth.stream).toBe(stream);
        expect(auth.botId).toBe("bot_1");
      }
    });
  }

  it("a video frame nobody is listening for is dropped, not replayed later", () => {
    const { relay, token } = setup();
    relay.onRecallMessage(token, JSON.stringify({ trigger: "realtime_video.per_participant", data: { participant_uuid: "p", frame: "x" } }));
    const seen: string[] = [];
    relay.addClient("bot_1", { send: (d) => seen.push(d), close: () => {} });
    expect(seen).toHaveLength(0);
  });

  it("but a state change that arrives before anyone connects is kept", () => {
    const { relay, token } = setup();
    relay.onRecallMessage(token, JSON.stringify({ trigger: "bot.state_change", data: { new_state: "joined_recording" } }));
    const seen: string[] = [];
    relay.addClient("bot_1", { send: (d) => seen.push(d), close: () => {} });
    expect(seen).toHaveLength(1);
  });
});
