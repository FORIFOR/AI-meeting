/**
 * Why a meeting bot could not join or had to leave, in terms an operator can act on.
 *
 * Recall reports these as `sub_code` on `bot.fatal` / `bot.call_ended`. They are not an enum — Recall adds
 * values without notice — so anything unknown must still produce a usable message rather than fall through
 * to a blank screen. The `action` is the thing the person reading it can actually do; several of these are
 * meeting or workspace settings the operator, not the product, has to change.
 */
export type BotFailureCategory =
  | "meeting_settings" // the host or their organisation has to change something
  | "credentials" // an authenticated bot is needed, or its logins ran out
  | "meeting_state" // wrong link, not started, already over
  | "capacity" // Recall side, retryable
  | "left" // ordinary end of call
  | "unknown";

export interface BotFailure {
  subCode: string;
  category: BotFailureCategory;
  /** Shown to the operator. */
  message: string;
  /** What to do about it; empty when nothing can be done. */
  action: string;
  /** Whether sending the bot again could plausibly work without changing anything. */
  retryable: boolean;
}

const TABLE: Record<string, Omit<BotFailure, "subCode">> = {
  google_meet_bot_blocked: {
    category: "meeting_settings",
    message: "Google Meet が参加を拒否しました。",
    action: "主催者側の Meet 設定（外部参加の可否・主催者による承認）を確認してください。",
    retryable: false,
  },
  google_meet_knocking_disabled: {
    category: "meeting_settings",
    message: "この会議はノック（参加リクエスト）が無効です。",
    action: "主催者に招待してもらうか、認証済みボットのアカウントをカレンダー招待に含めてください。",
    retryable: false,
  },
  google_meet_organisation_restricted: {
    category: "meeting_settings",
    message: "主催者の組織メンバーだけが参加できる会議です。",
    action: "Meet の安全性設定を変更するか、組織内アカウントの認証済みボットを使ってください。",
    retryable: false,
  },
  google_meet_login_not_available: {
    category: "credentials",
    message: "認証済みボット用の Google アカウントが空いていません。",
    action: "ログイングループに Google ログインを追加してください（1 ログインあたり約 30 同時接続）。",
    retryable: true,
  },
  google_meet_sign_in_missing_login_credentials: {
    category: "credentials",
    message: "サインイン必須の会議ですが、ボットの認証情報が設定されていません。",
    action: "認証済み Google Meet ボット（Google ログイングループ）を設定してください。",
    retryable: false,
  },
  google_meet_sso_sign_in_failed: {
    category: "credentials",
    message: "ボットの Google SSO サインインに失敗しました。",
    action: "専用 Workspace の SSO プロファイル（証明書・リダイレクト URL）を確認してください。",
    retryable: true,
  },
  google_meet_sign_in_failed: { category: "credentials", message: "ボットの Google サインインに失敗しました。", action: "ボットアカウントの状態を確認してください。", retryable: true },
  google_meet_sign_in_captcha_failed: { category: "credentials", message: "サインイン時に CAPTCHA が出て失敗しました。", action: "ボットアカウントに一度手動でサインインし、時間をおいて再試行してください。", retryable: true },
  meeting_requires_sign_in: {
    category: "credentials",
    message: "サインイン済みのユーザーだけが参加できる会議です。",
    action: "認証済みボットを設定してください。",
    retryable: false,
  },
  meeting_not_started: { category: "meeting_state", message: "会議がまだ開始されていません。", action: "主催者が会議を開始してから再度お試しください。", retryable: true },
  meeting_link_invalid: { category: "meeting_state", message: "会議リンクが不正です。", action: "URL を確認してください。", retryable: false },
  meeting_link_expired: { category: "meeting_state", message: "会議リンクの有効期限が切れています。", action: "新しいリンクを発行してください。", retryable: false },
  meeting_not_found: { category: "meeting_state", message: "会議が見つかりません。", action: "URL を確認してください。", retryable: false },
  meeting_locked: { category: "meeting_state", message: "会議がロックされています。", action: "主催者にロック解除を依頼してください。", retryable: true },
  meeting_full: { category: "meeting_state", message: "会議が満員です。", action: "参加者数の上限を確認してください。", retryable: true },
  meeting_ended: { category: "left", message: "会議が終了しました。", action: "", retryable: false },
  timeout_exceeded_waiting_room: {
    category: "meeting_settings",
    message: "待機室で承認されないまま時間切れになりました。",
    action: "主催者に承認を依頼するか、ボットのアカウントをカレンダー招待に含めて待機室を回避してください。",
    retryable: true,
  },
  timeout_exceeded_noone_joined: { category: "left", message: "参加者が現れなかったため退出しました。", action: "", retryable: true },
  timeout_exceeded_everyone_left: { category: "left", message: "全員が退出したため退出しました。", action: "", retryable: false },
  timeout_exceeded_silence_detected: { category: "left", message: "無音が続いたため退出しました。", action: "", retryable: true },
  bot_kicked_from_call: { category: "left", message: "会議から退出させられました。", action: "", retryable: true },
  bot_received_leave_call: { category: "left", message: "退出しました。", action: "", retryable: true },
  google_meet_internal_error: { category: "capacity", message: "Google Meet 側の一時的な問題で失敗しました。", action: "しばらく待って再試行してください。", retryable: true },
  google_meet_meeting_room_not_ready: { category: "capacity", message: "会議室がまだ準備できていません。", action: "しばらく待って再試行してください。", retryable: true },
};

export function describeBotFailure(subCode: string | null | undefined): BotFailure {
  const key = (subCode ?? "").trim();
  const hit = key ? TABLE[key] : undefined;
  if (hit) return { subCode: key, ...hit };
  // Unknown or absent: still say something true and point at where the detail lives.
  return {
    subCode: key,
    category: "unknown",
    message: key ? `ボットが会議に参加できませんでした（${key}）。` : "ボットが会議に参加できませんでした。",
    action: "Recall のボットログで詳細を確認してください。",
    retryable: true,
  };
}

/** Sub codes that mean "do not send this bot again until something changes". */
export function isPermanentBotFailure(subCode: string | null | undefined): boolean {
  return !describeBotFailure(subCode).retryable;
}
