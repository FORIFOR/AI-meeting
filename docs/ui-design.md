# UI design — 会話のための空間 (not an AI dashboard)

This product is a room where someone talks with a character. It is not a console for an AI pipeline.
The avatar carries the state; the interface gets out of the way and returns only when it is needed.

## 0. Information levels

Every screen classifies its content. **Level 2 and 3 never appear inside Level 1 unless the user opens them.**

| Level | Meaning | Where it may live |
|---|---|---|
| 1 Primary | what the user is doing right now | the screen itself |
| 2 Secondary | needed occasionally (transcript, character, engine, captions, evaluation) | the ··· sheet, the results screen, settings |
| 3 Advanced | technical / debug (provider routing per role, STT/TTS/VAD, latency, egress, device, incident tooling) | Settings → 詳細設定, or the session sheet's 開発者 section |

## 1. Audit of the previous UI (2026-08-31)

| Screen | Primary goal | Was wrong | Action |
|---|---|---|---|
| Home | choose what to practise | 4 product rows + character grid + engine radio list + strict toggle + service status + settings link all at once (Level 1+2+3 on one page) | one question, four text actions, one continuation line; character and engine moved out |
| Character | choose who to talk with | 6 equal tiles in a side panel, each with renderer badge, licence and BLOCKED code | its own screen: one large character, neighbours either side, one line of personality |
| Setup | set up the session | slip with persona chips + 4 selects + a full engine selector (Level 3) inside the flow | grouped label→value rows; engine lives in settings; start is the only primary action |
| Session | talk | permanent state pill, latency HUD, provider menu, human-gate panel, self camera, caption list, 4 controls, tap hint | avatar + name + latest line + three controls + ···; everything else in the sheet; state is shown by behaviour and a faint whisper |
| Result | understand how it went | 6 scores, criteria, per-question table, gate ratings, observability card, transcript — all equal weight | overall → one-line reading → the single most important fix → criteria → evidence/transcript → secondary actions |
| Settings | change endpoints | card with two inputs and a HUD toggle | grouped rows: 会話 / キャラクター / セッション / 詳細設定 |
| Meeting | send the character into a call | two slips side by side, bilingual labels, mode select in the main flow | one column of rows; connection mode and bot diagnostics under 詳細 |

Removed globally: bordered boxes around every group, the second column on Home, renderer badges, licence lines in the picker, provider names in the conversation screen, the "tap to interrupt" hint, emoji controls, `BLOCKED_BY_*` in normal flow (tooltip + reports only).

## 2. Wireframes

```
HOME                                         CHARACTER
                                             ┌─────────────────────────────┐
  こんばんは。                                 │        話す相手を選ぶ         │
  何を練習しますか？                            │                             │
                                             │          ( Yui )            │
  面接練習   英会話   雑談   営業ロープレ         │                             │
                                             │           Yui               │
  ── 前回のつづき ──────────                   │    明るく親しみやすい・日本語   │
  Yui · 面接練習 · 昨日            ›           │   ‹ Reina    Haru    Kei ›  │
                                             │        これで始める          │
                          相手を変える  設定 › └─────────────────────────────┘

SESSION (Level 1 only)                       SESSION ··· sheet (Level 2/3)
  面接練習                            ···       ┌─────────────────────────────┐
                                             │ 字幕                    表示 │
             [ avatar fills the frame ]      │ カメラ                  非表示 │
                                             │ 相手                 Yui  ›  │
                                             │ ─────────────────────────── │
                    Yui                      │ エンジン              ローカル │
      「では、自己紹介からお願いします」          │ ─── 開発者 ───────────────── │
                                             │ 遅延の表示                 ○ │
        ◉ マイク    ◉ カメラ    ◉ 終了         │ 評価パネル                 ○ │
                                             └─────────────────────────────┘

RESULT                                       SETTINGS
  面接練習 · 12分                                会話
  82                                            エンジン                 自動
  受け答えは明快。例をもう一段具体にすると強い。     言語                   日本語
  ─────────────────────────────                キャラクター
  いちばん効くのはここ                            Yui                    変更 ›
  「チームで改善しました」                         セッション
  → 何を変えたか、自分の担当、数字で示す           字幕                     表示
  ─────────────────────────────                カメラ                   非表示
  明瞭さ 88   具体性 72   構成 85   関連性 91      詳細設定 ›
  会話を読み返す ›   この質問をもう一度 ›
```

## 3. Visual system

- **Palette.** `--bg #faf9f7`, `--surface #ffffff`, text `#171614` / `#57544f` / `#8e8a83`, hairline `rgba(23,22,20,.09)`. One accent, `--accent #b0402b`, used only for: the selected character mark, the overall score, a destructive control, an error. Providers have no colour — they are plumbing.
- **Containers.** A border or a background must earn its place: inputs, buttons, the ··· sheet, the avatar frame. No section backgrounds, no nested boxes, no shadow on static content. Shadow only on floating layers (sheet, menu, toast).
- **Radius.** 6px for controls, 14px for floating sheets, 0 for sections.
- **Type.** Display 34/40 (Zen Old Mincho) for the one moment per screen that matters; title 22–24; section 15 semibold; body 15; secondary 13; metadata 11 (mono only for numbers, codes and the developer HUD).
- **Spacing.** 8px base, sections 40–64px apart. Prefer空白 over dividers; prefer dividers over boxes.
- **Motion.** 140ms control feedback · 220ms panels/sheets · 320ms screen changes. No bounce. The avatar is the expressive motion.

## 4. State without labels

`LISTENING / THINKING / SPEAKING` is communicated by the character: gaze and small nods while listening, a brief look away and stillness while thinking, lip sync and body motion while speaking. A faint lowercase whisper (11px, opacity 0.28) appears for ~1.6s on change and then fades — it also keeps the state readable for the automated Reality-Gate runners, which match that word.

## 5. Responsive

| Screen | ≥900px | <900px |
|---|---|---|
| Home | question + actions in one column, continuation below | same, actions stack, type scales down |
| Character | large portrait with neighbours either side | portrait fills width, neighbours become a swipe strip |
| Session | avatar fills the frame, controls float at the bottom | identical priority; controls become a bottom bar, the sheet becomes a bottom sheet |
| Result | one 720px column | same column, score row wraps 2×2 |
| Settings / Meeting | label→value rows | value wraps under the label |

## 6. Screens captured

`docs/reports/img/ui/` — 01 home · 02 character · 03 setup · 04 listening · 05 thinking · 06 speaking · 07 session sheet · 08 result · 09 settings · 10 mobile conversation.
