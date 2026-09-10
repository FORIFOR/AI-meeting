# Mac desktop app — local setup

設定 → 「ローカルAIを、かんたんに。」 → モデルを選択 → 「ダウンロードして使う」。準備完了後の「ローカル会話を始める」で接続先を専用ループバックに切り替え、完全ローカルモードにします。ターミナル、Homebrew、Nodeの別途インストールは不要です。

- 8GB以上のMacに対応。24GB未満は軽量1.5B、24GB以上では標準7Bを推奨。初回は約1.4GB / 4.9GBのダウンロードと余裕のある空き容量が必要です。
- 初回のみモデル取得にインターネットを使用。SHA-256検証、途中再開、中止・再試行に対応。
- セットアップ済みならアプリの次回起動時に自動起動。停止ボタンまたはアプリ終了で子プロセスを終了。
- 会話用LLM、SenseVoice音声認識、macOS読み上げを利用。Meet/Zoom Bot・Gemini Liveの費用は対象外。
- モデルはアプリのApplication Support領域に保存。音声や会話内容をセットアップ状態ファイルに記録しません。
- 配布はビルドしたMacと同じCPU向けです。Apple Silicon版はIntel Mac用ではありません。

## Development and distribution

`pnpm --filter @rcai/desktop build --bundles app` prepares a portable runtime before building. Requires the existing repository dependencies and a Mac development environment. `scripts/build-local-runtime.mjs` downloads pinned Node and llama.cpp archives, bundles the agent, and includes the platform sherpa addon. The end-user installer only downloads model data. Runtime resources are generated and ignored by Git.

For Developer ID distribution, set `APPLE_SIGNING_IDENTITY` to your certificate name when building: nested executables and libraries are signed before the app is sealed. Notarize/staple the resulting app separately before distributing it. Never modify its resources after signing.

Validation: `node --test apps/desktop/local-runtime/setup.test.mjs`, `pnpm --filter @rcai/desktop check`, and the web LocalSetup component tests. Dedicated runtime ports are 18080 (LLM) and 18788 (agent); an occupied port produces an error rather than attaching to a different local service.
