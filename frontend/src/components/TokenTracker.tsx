import { useState, useEffect, useRef, useCallback } from "react";
import type { Metadata } from "../types";
import { api } from "../api";
import type { ClaudeUsageLimit, ClaudeUsageResponse } from "../api";

const BASE_POLL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface Props {
  metadata: Metadata;
  onRefresh: () => void;
}

function formatResetTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffH = diffMs / 3600000;

  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: undefined, hour12: true });

  if (diffH < 0) return "resetting...";
  if (diffH < 24) return `Resets ${timeStr}`;

  const dayStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `Resets ${dayStr} at ${timeStr}`;
}

function UsageBar({ title, limit }: { title: string; limit: ClaudeUsageLimit }) {
  if (limit.utilization === null) return null;

  const pct = Math.min(limit.utilization, 100);
  const barColor =
    pct >= 90 ? "var(--red)" :
    pct >= 70 ? "var(--amber)" :
    "var(--accent-light)";

  return (
    <div className="usage-bar-section">
      <div className="usage-bar-title">{title}</div>
      <div className="usage-bar-row">
        <div className="usage-bar-track">
          <div
            className="usage-bar-fill"
            style={{ width: `${pct}%`, background: barColor }}
          />
        </div>
        <span className="usage-bar-pct">{Math.floor(pct)}%</span>
      </div>
      {limit.resets_at && (
        <div className="usage-bar-reset">{formatResetTime(limit.resets_at)}</div>
      )}
    </div>
  );
}

export function TokenTracker({ metadata, onRefresh: _ }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [usage, setUsage] = useState<ClaudeUsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const failCount = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usageRef = useRef(usage);
  usageRef.current = usage;

  const fetchUsageRef = useRef<(manual?: boolean) => Promise<void>>(undefined!);

  const scheduleNext = useCallback((failures: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (failures >= MAX_CONSECUTIVE_FAILURES) return; // stop polling
    const delay = BASE_POLL_MS * Math.pow(2, failures);
    timerRef.current = setTimeout(() => fetchUsageRef.current?.(), delay);
  }, []);

  const fetchUsage = useCallback(async (manual = false) => {
    if (manual) failCount.current = 0;
    setLoading(true);
    if (manual) { setError(null); setStale(false); }
    try {
      const data = await api.getClaudeUsage();
      if (data.error) {
        failCount.current += 1;
        if (usageRef.current) setStale(true);
        setError(data.error);
      } else {
        failCount.current = 0;
        setUsage(data);
        setError(null);
        setStale(false);
      }
    } catch {
      failCount.current += 1;
      if (usageRef.current) setStale(true);
      setError("Failed to fetch usage data");
    } finally {
      setLoading(false);
      scheduleNext(failCount.current);
    }
  }, [scheduleNext]);

  fetchUsageRef.current = fetchUsage;

  useEffect(() => {
    fetchUsage();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const persistentlyUnavailable = failCount.current >= MAX_CONSECUTIVE_FAILURES;
  const hasUsage = usage !== null;
  const sessionPct = hasUsage && usage.five_hour?.utilization != null
    ? Math.floor(usage.five_hour.utilization) : null;

  return (
    <div className="token-tracker">
      <button
        className="token-tracker-header"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="token-tracker-title">
          {collapsed ? "▸" : "▾"} Usage
        </span>
        <span className="token-tracker-summary">
          {loading && !usage ? "..." :
           persistentlyUnavailable && !hasUsage ? "unavailable" :
           stale && sessionPct !== null ? `Session: ${sessionPct}% (stale)` :
           sessionPct !== null ? `Session: ${sessionPct}%` :
           error ? "unavailable" : ""}
        </span>
      </button>

      {!collapsed && (
        <div className="token-tracker-body">
          {loading && !usage && (
            <div className="usage-loading">Loading usage data...</div>
          )}

          {error && (
            <div className={persistentlyUnavailable ? "usage-unavailable" : "usage-error"}>
              {persistentlyUnavailable
                ? "Usage endpoint is unavailable — polling paused."
                : error}
              <button className="btn-link" onClick={() => fetchUsage(true)} style={{ marginLeft: 8 }}>
                Retry
              </button>
            </div>
          )}

          {stale && hasUsage && (
            <div className="usage-stale-banner">
              Showing last known data — live updates failed.
            </div>
          )}

          {hasUsage && (
            <>
              {usage.five_hour && (
                <UsageBar title="Current session" limit={usage.five_hour} />
              )}
              {usage.seven_day && (
                <UsageBar title="Current week (all models)" limit={usage.seven_day} />
              )}
              {usage.seven_day_sonnet && (
                <UsageBar title="Current week (Sonnet only)" limit={usage.seven_day_sonnet} />
              )}
              {usage.seven_day_opus && (
                <UsageBar title="Current week (Opus only)" limit={usage.seven_day_opus} />
              )}
              {usage.extra_usage && (
                <div className="usage-extra">
                  Extra usage: {usage.extra_usage.is_enabled ? "enabled" : "not enabled"}
                </div>
              )}
            </>
          )}

          {/* App token stats */}
          {metadata.total_analyses > 0 && (
            <div className="usage-app-stats">
              <div className="usage-app-stats-label">App analysis totals</div>
              <div className="usage-app-stats-row">
                <span>${metadata.total_cost_usd.toFixed(2)}</span>
                <span>{metadata.total_analyses} runs</span>
                <span>{((metadata.total_input_tokens + metadata.total_output_tokens) / 1000).toFixed(0)}k tokens</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
