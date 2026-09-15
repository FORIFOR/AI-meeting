import type { BrokerEnv } from "./env.js";

/** An explicit launch setting. Self-hosted installations keep their existing behavior. */
export const publicDemoOnly = (env: BrokerEnv): boolean => env.RCAI_PUBLIC_DEMO_ONLY === "1";
export const PUBLIC_DEMO_ONLY_MESSAGE = "公開版では音声とアバターのデモを利用できます。AIとの会話や会議Botは、ご自身の環境で接続先を設定してご利用ください。";

/** Only routes that initiate new provider work. Cleanup remains reachable. */
export function startsProviderWork(method: string, path: string): boolean {
  const route = path.replace(/\/+$/, "");
  if (method === "GET") return route === "/api/meeting/calendar/oauth-callback";
  if (method === "PUT") return route === "/api/calendar/rule";
  if (method !== "POST") return false;
  return /^\/api\/(?:token\/(?:openai|gemini)|session\/openai-live|evaluate|plan|livekit\/token)$/.test(route)
    || /^\/api\/avatar\/(?:heygen\/session|anam\/session|tavus\/conversation)$/.test(route)
    || /^\/api\/meeting\/(?:recall|attendee)\/bots$/.test(route)
    || /^\/api\/calendar\/events\/[^/]+\/optin$/.test(route)
    || /^\/api\/meeting\/recall\/bots\/[^/]+\/output_media\/restart$/.test(route);
}
