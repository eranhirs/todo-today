import { useState } from "react";
import type { Metadata } from "../types";
import { api } from "../api";

interface Props {
  metadata: Metadata;
  onRefresh: () => void;
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ClaudeStatus({ metadata, onRefresh }: Props) {
  const [waking, setWaking] = useState(false);

  const handleWake = async () => {
    setWaking(true);
    try {
      await api.wakeUpClaude();
      onRefresh();
    } finally {
      setWaking(false);
    }
  };

  const isRecent = metadata.heartbeat &&
    (Date.now() - new Date(metadata.heartbeat).getTime()) < 10 * 60 * 1000;

  return (
    <div className="claude-status">
      <div className="status-row">
        <span className={`status-dot ${isRecent ? "active" : "inactive"}`} />
        <span className="status-label">
          Claude {metadata.scheduler_status === "running" ? "active" : "stopped"}
        </span>
      </div>
      {metadata.heartbeat && (
        <div className="status-detail">Last heartbeat: {timeAgo(metadata.heartbeat)}</div>
      )}
      {metadata.last_analysis && (
        <div className="status-detail">
          Last analysis: {timeAgo(metadata.last_analysis.timestamp)} — {metadata.last_analysis.summary}
        </div>
      )}
      <button className="btn-wake" onClick={handleWake} disabled={waking}>
        {waking ? "⏳ Analyzing..." : "🔔 Wake Up Claude"}
      </button>
      {metadata.total_analyses > 0 && (
        <div className="usage-totals">
          Total: {metadata.total_analyses} analyses | ${metadata.total_cost_usd.toFixed(2)} | {((metadata.total_input_tokens + metadata.total_output_tokens) / 1000).toFixed(1)}k tokens
        </div>
      )}
    </div>
  );
}
