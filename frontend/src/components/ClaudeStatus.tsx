import { useState } from "react";
import type { Metadata, SessionInfo } from "../types";
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

function formatTime(epoch: number): string {
  const d = new Date(epoch * 1000);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 1) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

export function ClaudeStatus({ metadata, onRefresh }: Props) {
  const [waking, setWaking] = useState(false);
  const [selectedModel, setSelectedModel] = useState(metadata.analysis_model);
  const [wakeMessage, setWakeMessage] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const isOverride = selectedModel !== metadata.analysis_model;

  const handleWake = async (force = false, sessionKeys?: string[]) => {
    setWaking(true);
    setWakeMessage(null);
    try {
      const res = await api.wakeUpClaude(
        isOverride ? selectedModel : undefined,
        force || undefined,
        sessionKeys,
      );
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

  const handleBrowseSessions = async () => {
    if (showSessions) {
      setShowSessions(false);
      return;
    }
    setLoadingSessions(true);
    try {
      const data = await api.getSessions();
      setSessions(data);
      setSelectedKeys(new Set());
      setShowSessions(true);
    } finally {
      setLoadingSessions(false);
    }
  };

  const toggleSessionKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAnalyzeSelected = () => {
    if (selectedKeys.size === 0) return;
    handleWake(false, [...selectedKeys]);
    setShowSessions(false);
  };

  // Group sessions by project_name
  const sessionsByProject: Record<string, SessionInfo[]> = {};
  for (const s of sessions) {
    (sessionsByProject[s.project_name] ??= []).push(s);
  }

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
      <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
        <button className="btn-wake" style={{ flex: 1, marginTop: 0 }} onClick={() => handleWake()} disabled={waking}>
          {waking ? "⏳ Analyzing..." : "🔔 Wake Up Claude"}
        </button>
        <button
          className="btn-wake"
          style={{ flex: 0, marginTop: 0, whiteSpace: "nowrap", fontSize: "0.8rem" }}
          onClick={handleBrowseSessions}
          disabled={loadingSessions}
        >
          {loadingSessions ? "..." : showSessions ? "Close" : "📂 Sessions"}
        </button>
      </div>
      {showSessions && (
        <div className="session-picker">
          <div className="session-picker-header">
            <span>All Sessions ({sessions.length})</span>
            <button
              className="btn-wake"
              style={{ padding: "4px 10px", fontSize: "0.75rem", marginTop: 0 }}
              onClick={handleAnalyzeSelected}
              disabled={selectedKeys.size === 0 || waking}
            >
              Analyze Selected ({selectedKeys.size})
            </button>
          </div>
          {Object.entries(sessionsByProject).map(([projectName, projectSessions]) => (
            <div key={projectName} className="session-group">
              <div className="session-group-name">{projectName}</div>
              {projectSessions.map((s) => (
                <label key={s.key} className="session-item">
                  <input
                    type="checkbox"
                    className="session-checkbox"
                    checked={selectedKeys.has(s.key)}
                    onChange={() => toggleSessionKey(s.key)}
                  />
                  <span className="session-id" title={s.session_id}>
                    {s.session_id.slice(0, 8)}...
                  </span>
                  <span className="session-meta">
                    {s.message_count} msgs · {formatTime(s.mtime)}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      {metadata.total_analyses > 0 && (
        <div className="usage-totals">
          Total: {metadata.total_analyses} analyses | ${metadata.total_cost_usd.toFixed(2)} | {((metadata.total_input_tokens + metadata.total_output_tokens) / 1000).toFixed(1)}k tokens
        </div>
      )}
    </div>
  );
}
