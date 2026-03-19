import { useState, useEffect } from "react";
import type { Metadata } from "../types";
import { api } from "../api";
import type { ClaudeUsageLimit, ClaudeUsageResponse } from "../api";

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

  const fetchUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getClaudeUsage();
      if (data.error) {
        setError(data.error);
      } else {
        setUsage(data);
      }
    } catch {
      setError("Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsage();
    const id = setInterval(fetchUsage, 60_000);
    return () => clearInterval(id);
  }, []);

  const hasUsage = usage && !error;
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
           error ? "unavailable" :
           sessionPct !== null ? `Session: ${sessionPct}%` : ""}
        </span>
      </button>

      {!collapsed && (
        <div className="token-tracker-body">
          {loading && !usage && (
            <div className="usage-loading">Loading usage data...</div>
          )}

          {error && (
            <div className="usage-error">
              {error}
              <button className="btn-link" onClick={fetchUsage} style={{ marginLeft: 8 }}>Retry</button>
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
