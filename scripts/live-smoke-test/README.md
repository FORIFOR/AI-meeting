# GPT-Live official SDK smoke test

Standalone localhost test; imports no AI-meeting application code. Uses `openai@7.15.0` (npm's latest version when checked on 2026-09-11), `client.live.create`, real browser SDP, and no automatic retries. It binds only to `127.0.0.1`. API keys stay on the server.

Requires Node.js 22.6+ and an existing `OPENAI_API_KEY` in the server environment. Configure the key through your normal secret mechanism; do not put it in the HTML, source, URL, or evidence files.

From this directory, install the isolated dependency:

```sh
npm install --no-audit --no-fund --ignore-scripts
```

Prepare `hello.wav`, a short non-sensitive Japanese test recording. On macOS the built-in synthetic voice can generate it without a microphone or external API:

```sh
say -v Kyoko -r 160 -o hello.aiff 'こんにちは。接続の確認です。短く返事をしてください。'
afconvert -f WAVE -d LEI16@24000 hello.aiff hello.wav
npm start
```

Open `http://127.0.0.1:4591/`. The first button uses GPT-Live with Terra Responses delegation. The second removes delegation and leaves only the model and short instructions. Each browser/configuration/transport combination permits one request per server run. SDK retries are disabled. Session creation can incur API usage; this is an actual API test.

For a deliberate SDK/raw comparison, select the checkbox before starting. Only after an SDK HTTP 500 does the client make one raw `fetch` call, preserving the exact same SDP and session configuration. This is an explicit two-request comparison, not a normal connection retry. The checkbox is off by default. Chrome and Safari can be opened separately against the same local server; their user agents and SDP hashes are recorded.

The client waits for `session.started`, then sends the prepared audio through its negotiated media track. It plays received audio, measures its peak, records transcript events, sends `session.close`, and waits for final usage. A hard deadline closes browser media resources if startup or finalization stalls. WebRTC data-channel `session.start` and audio append events are never sent.

`evidence.jsonl` records sanitized HTTP status, endpoint, request ID / Cloudflare ray when available, SDK version, config, browser user agent, SDP hash and codec summary, and browser lifecycle. It excludes the API key and full SDP. Full offers are kept separately in git-ignored `offer-*.sdp` files with mode 0600 for local comparison; they contain ICE/network details and should be reviewed/redacted before sharing. A model metadata response of 200 is not a successful voice test; require `session.started`, transcript/audio evidence, and distinguish finalization from local cleanup.

Initial 2026-09-11 result: both variants returned HTTP 500 before any session ID or SDP answer. See [verification report](../../docs/validation.md). After the user replenished API credit, the minimal SDK test connected, received Japanese audio and finalized successfully; a separate application playback issue was then fixed. See [post-credit recovery](../../docs/validation.md).
