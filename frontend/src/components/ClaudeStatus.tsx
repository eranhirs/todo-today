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

const INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30, 60];
const MODEL_OPTIONS = ["haiku", "sonnet", "opus"];

export function ClaudeStatus({ metadata, onRefresh }: Props) {
  const [waking, setWaking] = useState(false);
  const [selectedModel, setSelectedModel] = useState(metadata.analysis_model);
  const [wakeMessage, setWakeMessage] = useState<string | null>(null);

  const isOverride = selectedModel !== metadata.analysis_model;

  const handleWake = async (force = false) => {
    setWaking(true);
    setWakeMessage(null);
    try {
      const res = await api.wakeUpClaude(isOverride ? selectedModel : undefined, force || undefined);
      if (res.status === "skipped") {
        setWakeMessage(res.message ?? "No changes since last analysis");
      } else {
        setWakeMessage(null);
      }
      onRefresh();
    } finally {
      setWaking(false);
    }
  };

  const handleIntervalChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    await api.setAnalysisInterval(Number(e.target.value));
    onRefresh();
  };

  const handleMakePermanent = async () => {
    await api.setAnalysisModel(selectedModel);
    onRefresh();
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
        <select
          className="interval-select"
          value={metadata.analysis_interval_minutes}
          onChange={handleIntervalChange}
          title="Analysis interval"
        >
          {INTERVAL_OPTIONS.map((m) => (
            <option key={m} value={m}>{m}m</option>
          ))}
        </select>
        <select
          className="model-select"
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          title="Analysis model"
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>
      {isOverride && (
        <div className="status-detail model-override-note">
          Using <strong>{selectedModel}</strong> for this wake only.{" "}
          <button className="btn-link" onClick={handleMakePermanent}>Make permanent</button>
        </div>
      )}
      {wakeMessage && (
        <div className="status-detail wake-message">
          {wakeMessage}{" "}
          <button className="btn-link" onClick={() => handleWake(true)} disabled={waking}>
            Force analyze
          </button>
        </div>
      )}
      {metadata.heartbeat && (
        <div className="status-detail">Last heartbeat: {timeAgo(metadata.heartbeat)}</div>
      )}
      {metadata.last_analysis && (
        <div className="status-detail">
          Last analysis: {timeAgo(metadata.last_analysis.timestamp)}
          {metadata.last_analysis.model && ` (${metadata.last_analysis.model})`} — {metadata.last_analysis.summary}
        </div>
      )}
      <button className="btn-wake" onClick={() => handleWake()} disabled={waking}>
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
