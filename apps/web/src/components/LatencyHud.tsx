import type { LatencyTracker } from "@rcai/audio-core";
import type { SessionReport } from "@rcai/observability";

type Report = ReturnType<LatencyTracker["report"]>;
const ROWS: { key: keyof Report; label: string }[] = [
  { key: "turn_response", label: "turn p50/p95" },
  { key: "interrupt_stop", label: "barge-in stop" },
  { key: "listening_react", label: "→ listening" },
  { key: "mouth_stop", label: "mouth stop" },
];

function fmt(n: number) {
  return Number.isFinite(n) ? `${Math.round(n)}` : "–";
}

export function LatencyHud({ report, providerId, observability }: { report: Report | null; providerId: string | null; observability?: SessionReport | null }) {
  const o = observability ?? null;
  return (
    <div className="hud">
      <div className="hud__title">latency · {providerId ?? "—"}</div>
      <table>
        <tbody>
          {ROWS.map(({ key, label }) => {
            const r = report?.[key];
            if (!r) return (
              <tr key={key}><td>{label}</td><td>–</td></tr>
            );
            const t = r.target;
            const ok = r.count === 0 ? null : t.max !== undefined ? r.max <= t.max : (t.p50 === undefined || r.p50 <= t.p50) && (t.p95 === undefined || r.p95 <= t.p95);
            const value = key === "turn_response" ? `${fmt(r.p50)} / ${fmt(r.p95)} ms` : `${fmt(r.max)} ms`;
            const target = t.max !== undefined ? `< ${t.max}` : `< ${t.p50} / ${t.p95}`;
            return (
              <tr key={key}>
                <td>{label}</td>
                <td className={ok === null ? "" : ok ? "is-ok" : "is-bad"}>{value}</td>
                <td style={{ opacity: 0.5 }}>{target} · n={r.count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {o && (
        <table className="hud__obs">
          <tbody>
            <tr><td>turns</td><td>{o.turns.user} / {o.turns.assistant}</td><td style={{ opacity: 0.5 }}>reconnects {o.reconnects} · stale {o.staleDrops}</td></tr>
            <tr><td>stt / ttft / ttfa</td><td>{fmt(o.stt.p50)} / {fmt(o.llmTtft.p50)} / {fmt(o.ttsTtfa.p50)} ms</td><td style={{ opacity: 0.5 }}>p50 · n={o.stt.count}</td></tr>
            <tr><td>lip delay / frame</td><td>{fmt(o.avatar.lipDelayMs.p50)} / {fmt(o.avatar.frameIntervalMs.p50)} ms</td><td style={{ opacity: 0.5 }}>errors {o.errors.count}{o.meeting ? ` · ${o.meeting.connector}:${o.meeting.state}` : ""}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
