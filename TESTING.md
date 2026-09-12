# Try AI Meeting in 3 minutes

[日本語](TESTING.ja.md) · [Open the free preview](https://ai-meeting.web.app/vrm-demo) · [Send feedback](https://github.com/FORIFOR/AI-meeting/issues/new?template=beta-feedback.yml)

Help us collect the first **10 independent experience reports**. We need people on different devices to tell us whether the voice, avatar, and controls feel right. No coding, account, API key, or microphone is needed to try the browser preview. GitHub sign-in is needed only to submit feedback.

## The browser test

The preview UI is currently Japanese. The labels below let you follow along in English. It plays recorded or local audio; it does not listen to you or generate a new AI reply.

| Step | What to do | What to look for |
| --- | --- | --- |
| 1. Open | [Open the preview](https://ai-meeting.web.app/vrm-demo) and wait for the character. | Does the model load? Is the page usable at your screen size? |
| 2. Listen | Press **声と表情を試す** (play voice). | Does the sound start? Does the mouth movement feel aligned with it? |
| 3. Stop | Press the square stop button, then play again. | Do the voice and mouth stop together? Can playback restart? |
| 4. React | Press **ほほえむ** (smile), **うなずく** (nod), and **考える** (think). | Does each reaction look clear and natural? Which looks odd? |
| 5. Report | [Leave one observation](https://github.com/FORIFOR/AI-meeting/issues/new?template=beta-feedback.yml). | Include your device/browser and what you tried. “It did not load” is useful too. |

We especially need Safari/iPhone, Firefox, Android, keyboard-only, and lower-powered device reports. These are **areas to test**, not a claim that every configuration is supported or validated.

Optional: open **自分のアバターや音声で試す** (try your own avatar/audio). Use a permitted VRM 0.0/1.0 model up to 50 MB with no external files, or non-private audio up to 180 seconds / 30 MB. The preview processes selected files in your browser. You do not need to upload files with your report.

## Prefer a one-line report?

Use the feedback form, or comment on the pinned tester invitation in [Issues](https://github.com/FORIFOR/AI-meeting/issues):

> Device/browser: … · Tried: … · Worked/failed: … · One thing to improve: …

English and Japanese are welcome. Posting once is enough. Stars and follows are optional, never a requirement to participate. GitHub reports are public; omit private conversations, credentials, and personal information.

## Developer track: live AI and tasks

Allow extra time for [provider setup](README.md#connect-an-ai-provider). Live conversation requires a self-hosted installation and separately configured local AI or a cloud provider. Cloud usage may incur provider charges. Use two fictional tasks and your own permitted test data.

1. Ask to add “Review sample document” and “Send sample reply”. Check the task list.
2. Mark the first complete and move the second to tomorrow. Review any proposed change before applying it.
3. Ask the AI to read the current tasks. Compare its answer with the saved task state; speech alone is not proof that a task changed.
4. Interrupt during a response. Check that the previous audio/caption stops and does not reappear.
5. Report your OS, browser, provider, commit/release, and the actual result. If setup failed, include the first failing step and a redacted error.

[Watch the 45-second example](https://youtu.be/qLenE6R7-nI) · [Measured validation and recording conditions](docs/validation.md)

Task records in this beta are session-local. This is not a test of durable storage, an external task service, or a completed Meet/Zoom integration. Those integrations remain experimental.
