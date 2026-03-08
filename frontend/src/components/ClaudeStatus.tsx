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
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null);
  const [hooksLoading, setHooksLoading] = useState(false);

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
      if (res.status === "skipped" || res.status === "busy") {
        setWakeMessage(res.message ?? (res.status === "busy" ? "Analysis already in progress" : "No changes since last analysis"));
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

  const toggleProject = (name: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllInProject = (projectSessions: SessionInfo[]) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      const allSelected = projectSessions.every((s) => next.has(s.key));
      for (const s of projectSessions) {
        if (allSelected) next.delete(s.key);
        else next.add(s.key);
      }
      return next;
    });
  };

  // Group sessions by project_name
  const sessionsByProject: Record<string, SessionInfo[]> = {};
  for (const s of sessions) {
    (sessionsByProject[s.project_name] ??= []).push(s);
  }
  const projectCount = Object.keys(sessionsByProject).length;

  const handleIntervalChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    await api.setAnalysisInterval(Number(e.target.value));
    onRefresh();
  };

  const handleMakePermanent = async () => {
    await api.setAnalysisModel(selectedModel);
    onRefresh();
  };

  const checkHooksStatus = async () => {
    try {
      const res = await api.getHooksStatus();
      setHooksInstalled(res.installed);
    } catch {
      setHooksInstalled(null);
    }
  };

  const handleToggleHooks = async () => {
    setHooksLoading(true);
    try {
      if (hooksInstalled) {
        await api.uninstallHooks();
      } else {
        await api.installHooks();
      }
      await checkHooksStatus();
    } finally {
      setHooksLoading(false);
    }
  };

  // Check hooks status on mount
  if (hooksInstalled === null && !hooksLoading) {
    checkHooksStatus();
  }

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
      <div className="session-picker-section">
        <button className="btn-link session-picker-toggle" onClick={handleBrowseSessions} disabled={loadingSessions}>
          {loadingSessions ? "Loading..." : showSessions ? "▾ Pick specific sessions" : "▸ Pick specific sessions"}
        </button>
        {showSessions && (
          <div className="session-picker">
            <div className="status-detail" style={{ marginBottom: "6px" }}>
              By default, Wake analyzes only sessions changed in the last 24h.
              Use this to re-analyze older sessions or pick specific ones.
              Sessions are grouped by their working directory from <code style={{ fontSize: "0.7rem" }}>~/.claude/projects/</code>.
            </div>
            <div className="session-picker-header">
              <span>{projectCount} projects, {sessions.length} sessions</span>
              <button
                className="btn-wake"
                style={{ padding: "4px 10px", fontSize: "0.75rem", marginTop: 0 }}
                onClick={handleAnalyzeSelected}
                disabled={selectedKeys.size === 0 || waking}
              >
                Analyze Selected ({selectedKeys.size})
              </button>
            </div>
            {Object.entries(sessionsByProject).map(([projectName, projectSessions]) => {
              const isExpanded = expandedProjects.has(projectName);
              const allSelected = projectSessions.every((s) => selectedKeys.has(s.key));
              const someSelected = projectSessions.some((s) => selectedKeys.has(s.key));
              return (
                <div key={projectName} className="session-group">
                  <div className="session-group-header">
                    <button
                      className="session-group-toggle"
                      onClick={() => toggleProject(projectName)}
                      title={projectSessions[0]?.source_path}
                    >
                      {isExpanded ? "▾" : "▸"} {projectName}
                      <span className="session-group-path-inline">{projectSessions[0]?.project_dir}</span>
                      <span className="session-group-count">{projectSessions.length}</span>
                    </button>
                    <input
                      type="checkbox"
                      className="session-checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                      onChange={() => toggleAllInProject(projectSessions)}
                      title="Select all sessions in this project"
                    />
                  </div>
                  {isExpanded && projectSessions.map((s) => (
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
                      <span
                        className="session-meta"
                        title={s.last_analyzed_mtime
                          ? `Last analyzed: ${formatTime(s.last_analyzed_mtime)}`
                          : "Never analyzed"}
                      >
                        {s.message_count} msgs · {formatTime(s.mtime)}
                        {s.state && s.state !== "unknown" && (
                          <span className={`session-state-badge state-${s.state}`} title={`Source: ${s.state_source || "jsonl"}`}>
                            {s.state.replace(/_/g, " ")}
                            {s.state_source === "hook" && <span className="live-dot" />}
                          </span>
                        )}
                        {s.last_analyzed_mtime && s.mtime > s.last_analyzed_mtime && (
                          <span className="session-changed-badge">changed</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {metadata.total_analyses > 0 && (
        <div className="usage-totals">
          Total: {metadata.total_analyses} analyses | ${metadata.total_cost_usd.toFixed(2)} | {((metadata.total_input_tokens + metadata.total_output_tokens) / 1000).toFixed(1)}k tokens
        </div>
      )}
      <div className="hooks-section">
        <span className="hooks-label">
          Hooks: {hooksInstalled === null ? "..." : hooksInstalled ? "installed" : "not installed"}
        </span>
        <button
          className="btn-link"
          onClick={handleToggleHooks}
          disabled={hooksLoading || hooksInstalled === null}
        >
          {hooksLoading ? "..." : hooksInstalled ? "Uninstall" : "Install"}
        </button>
        <span
          className="hooks-tooltip-icon"
          title="Adds lifecycle hooks to ~/.claude/settings.json that fire on session start/end and permission requests. This lets Todo Today detect session state in real time instead of polling JSONL files."
        >?</span>
      </div>
      <div className="analysis-toggles">
        <label className="toggle-row" title="Periodic heartbeat analysis on a timer">
          <input
            type="checkbox"
            checked={metadata.heartbeat_enabled}
            onChange={async (e) => {
              await api.setHeartbeatEnabled(e.target.checked);
              onRefresh();
            }}
          />
          <span>Scheduled analysis</span>
        </label>
        <label className="toggle-row" title="Auto-analyze when a hook event fires (session end, etc.)">
          <input
            type="checkbox"
            checked={metadata.hook_analysis_enabled}
            onChange={async (e) => {
              await api.setHookAnalysisEnabled(e.target.checked);
              onRefresh();
            }}
          />
          <span>Hook-triggered analysis</span>
        </label>
      </div>
    </div>
  );
}
