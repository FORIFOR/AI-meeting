import policy from "./release-policy.json";

/** Public promotion requires current-build evidence in `pnpm release:reality`. */
export const RELEASE_POLICY = policy;
export type ReleaseChannel = "public" | "beta" | "private_beta";
export function releaseChannel(value?: string): ReleaseChannel {
  if (value === undefined || value === "" || value === "beta") return "beta";
  return value === "private_beta" ? "private_beta" : "public";
}
export function stageAvailable(stage: string | undefined, channel: ReleaseChannel): boolean {
  return stage === "released" || (stage === "beta" && channel !== "public") || (stage === "private_beta" && channel === "private_beta");
}
export function modeAvailable(mode: string, channel: ReleaseChannel): boolean {
  return stageAvailable(policy.core, channel) && stageAvailable((policy.modes as Record<string, string>)[mode], channel);
}
export const RELEASE_LABEL: Record<string, string> = { released: "", beta: "ベータ", private_beta: "限定ベータ", disabled: "未対応" };
export function meetingPlatform(url: string): keyof typeof policy.platforms | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    const host = parsed.hostname.toLowerCase();
    if (host === "meet.google.com") return "google_meet";
    if (host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoom.com" || host.endsWith(".zoom.com")) return "zoom";
    if (host === "teams.microsoft.com" || host === "teams.live.com" || host === "teams.cloud.microsoft") return "microsoft_teams";
    return undefined;
  } catch { return undefined; }
}
export function platformAvailable(url: string, channel: ReleaseChannel): boolean {
  const platform = meetingPlatform(url);
  return !!platform && stageAvailable(policy.core, channel) && stageAvailable(policy.meeting, channel) && stageAvailable(policy.platforms[platform], channel);
}
