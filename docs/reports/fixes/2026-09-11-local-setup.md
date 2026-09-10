# Desktop local setup

Implemented a Tauri setup controller plus a bundled Node supervisor. Initial setup downloads revision-pinned Qwen GGUF and SenseVoice files with SHA-256 verification, resumable partial files and cancellation. A portable Node/llama.cpp runtime and the platform sherpa addon are bundled at build time. No Homebrew, Node or terminal installation is required on the end-user Mac. The app selects a recommendation by installed RAM and offers a smaller model. Launch and readiness checks cover model loading, speech adapters and an actual LLM completion. Existing dedicated ports are rejected. Child processes are stopped on app exit; successful installation enables startup on subsequent app launches.

The desktop settings screen exposes progress, errors, retry, stop, and switching the saved settings to strict-local and ws://127.0.0.1:18788. The web browser explains that native installation requires the desktop app. Cloud meeting bots remain cloud services.

Validation:
- Native cargo check and web typecheck passed.
- Three Node tests: recommendation tiers, range resume/checksum/cache/corrupt rejection, cancellation retaining a partial file.
- Two UI tests: native action routing + strict-local settings, and no native install button on Web.
- Clean runtime installation into /tmp/ai-meeting-local-setup-validation completed with the 1.5B profile (1,356,870,471 model bytes).
- The real voice E2E script passed through the bundled agent: STT 79ms, LLM TTFT 42ms, TTS first audio 872ms, first response audio 1066ms after utterance end. One synthetic utterance on this machine; not a general latency guarantee.
- Stopping closed the local ports. Restart from the signed app's bundled Node v22.23.2 reached ready without downloading models.
- Developer ID-signed arm64 app built; deep/strict signature verification passed. App launched locally. This update has NOT been notarized: saved notary credential profile was not found under the checked names. Do not label it a notarized release.

Updated app: ~/Downloads/AI-Meeting-Local-Setup-20260911/AI Meeting.app. Runtime binaries and test model files are not committed to Git.
