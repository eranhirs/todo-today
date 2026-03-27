import { useState, useEffect } from "react";
import type { Metadata, SessionInfo, Settings } from "../types";
import { api } from "../api";
import { timeAgo, epochTimeAgo } from "../utils/formatting";

interface Props {
  metadata: Metadata;
  settings: Settings;
  analysisLocked: boolean;
  autopilotRunning: boolean;
  onRefresh: () => void;
}

const INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30, 60];
const MODEL_OPTIONS = ["haiku", "sonnet", "opus"];

export function ClaudeStatus({ metadata, settings, analysisLocked, autopilotRunning, onRefresh }: Props) {
  const [waking, setWaking] = useState(false);

  const busy = waking || analysisLocked;
  const [selectedModel, setSelectedModel] = useState(settings.analysis_model);
  const [wakeMessage, setWakeMessage] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const isOverride = selectedModel !== settings.analysis_model;
  const anyAnalysisEnabled = settings.heartbeat_enabled || settings.hook_analysis_enabled;

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
      } else if (res.status === "ok" && res.message) {
        // Informational message (e.g. autopilot tasks started without new analysis)
        setWakeMessage(res.message);
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
    const mins = Number(e.target.value);
    if (mins <= 10) {
      const ok = window.confirm(
        `An interval of ${mins}m can use a significant chunk of your API quota.\n\n` +
        `For real-time updates, hooks are a better approach — they only trigger ` +
        `analysis when sessions actually change, so you pay per-event instead of polling.\n\n` +
        `The heartbeat is mainly useful for catching updates while you're away.\n\n` +
        `Set interval to ${mins}m anyway?`
      );
      if (!ok) return;
    }
    await api.updateSettings({ analysis_interval_minutes: mins });
    onRefresh();
  };

  const handleMakePermanent = async () => {
    await api.updateSettings({ analysis_model: selectedModel });
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

  // Countdown to next heartbeat
  const [countdown, setCountdown] = useState("");
  useEffect(() => {
    if (!settings.heartbeat_enabled || !metadata.heartbeat) {
      setCountdown("");
      return;
    }
    const tick = () => {
      const nextBeat = new Date(metadata.heartbeat!).getTime() + settings.analysis_interval_minutes * 60 * 1000;
      const remaining = Math.max(0, Math.floor((nextBeat - Date.now()) / 1000));
      if (remaining <= 0) {
        setCountdown("due now");
        return;
      }
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      setCountdown(`${m}:${s.toString().padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [metadata.heartbeat, settings.heartbeat_enabled, settings.analysis_interval_minutes]);

  return (
    <div className="claude-status">
      <div className="status-row">
        <span className={`status-dot ${isRecent ? "active" : "inactive"}`} />
        <span className="status-label">
          Claude {metadata.scheduler_status === "running" ? "active" : "stopped"}
        </span>
        {settings.heartbeat_enabled && (
          <select
            className="interval-select"
            value={settings.analysis_interval_minutes}
            onChange={handleIntervalChange}
            title="Heartbeat interval"
          >
            {INTERVAL_OPTIONS.map((m) => (
              <option key={m} value={m}>{m}m</option>
            ))}
          </select>
        )}
        {anyAnalysisEnabled && (
          <select
            className="model-select"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            title="Model used for all analysis (scheduled + hook-triggered). Autopilot runs always use opus."
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
      </div>
      {anyAnalysisEnabled && (
        <div className="status-detail" style={{ opacity: 0.6, fontSize: "0.7rem" }}>
          Analysis model ({[settings.heartbeat_enabled && "scheduled", settings.hook_analysis_enabled && "hooks"].filter(Boolean).join(" + ")}). Runs use {settings.run_model}.
        </div>
      )}
      {isOverride && anyAnalysisEnabled && (
        <div className="status-detail model-override-note">
          Using <strong>{selectedModel}</strong> for this wake only.{" "}
          <button className="btn-link" onClick={handleMakePermanent}>Make permanent</button>
        </div>
      )}
      {settings.heartbeat_enabled && metadata.heartbeat && (
        <div className="status-detail">
          Last heartbeat: {timeAgo(metadata.heartbeat)}
          {countdown && (
            <span className="heartbeat-countdown"> · next in {countdown}</span>
          )}
        </div>
      )}
      {anyAnalysisEnabled && metadata.last_analysis && (
        <div className="status-detail">
          Last analysis: {timeAgo(metadata.last_analysis.timestamp)}
          {metadata.last_analysis.model && ` (${metadata.last_analysis.model})`} — {metadata.last_analysis.summary}
        </div>
      )}
      {autopilotRunning && (
        <div className="status-detail autopilot-indicator">Autopilot running...</div>
      )}
      {/* Manual analysis section — collapsed by default */}
      <div className="manual-analysis-section">
        <button
          className="btn-link manual-analysis-toggle"
          onClick={() => setShowManual(!showManual)}
        >
          {showManual ? "▾" : "▸"} Manual analysis
        </button>
        {showManual && (
          <div className="manual-analysis-body">
            {wakeMessage && (
              <div className="status-detail wake-message">
                {wakeMessage}{" "}
                <button className="btn-link" onClick={() => handleWake(true)} disabled={busy}>
                  Force analyze
                </button>
              </div>
            )}
            <button className="btn-wake" onClick={() => handleWake()} disabled={busy}>
              {busy ? "⏳ Analyzing..." : "🔔 Wake Up Claude"}
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
                  </div>
                  <div className="session-picker-header">
                    <span>{projectCount} projects, {sessions.length} sessions</span>
                    <button
                      className="btn-wake"
                      style={{ padding: "4px 10px", fontSize: "0.75rem", marginTop: 0 }}
                      onClick={handleAnalyzeSelected}
                      disabled={selectedKeys.size === 0 || busy}
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
                                ? `Last analyzed: ${epochTimeAgo(s.last_analyzed_mtime)}`
                                : "Never analyzed"}
                            >
                              {s.message_count} msgs · {epochTimeAgo(s.mtime)}
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
          </div>
        )}
      </div>
      {anyAnalysisEnabled && metadata.total_analyses > 0 && (
        <div className="usage-totals">
          <div>Total: {metadata.total_analyses} analyses | ${metadata.total_cost_usd.toFixed(2)} | {((metadata.total_input_tokens + metadata.total_output_tokens) / 1000).toFixed(1)}k tokens</div>
          {metadata.history.length >= 2 && (() => {
            const sorted = [...metadata.history].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            const firstDate = new Date(sorted[0].timestamp);
            const lastDate = new Date(sorted[sorted.length - 1].timestamp);
            const days = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / 86400000);
            const avgPerDay = metadata.total_cost_usd / days;
            return (
              <div style={{ opacity: 0.6, fontSize: "0.65rem" }}>
                ~${avgPerDay.toFixed(2)}/day avg
              </div>
            );
          })()}
        </div>
      )}
      <div className="run-model-section">
        <span className="hooks-label">Run model:</span>
        <select
          className="model-select"
          value={settings.run_model}
          onChange={async (e) => {
            await api.updateSettings({ run_model: e.target.value });
            onRefresh();
          }}
          title="Model used for todo runs and follow-ups. Per-project overrides take precedence."
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>
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
          title="Adds lifecycle hooks to ~/.claude/settings.json that fire on session start/end and permission requests. This lets Claude Todos detect session state in real time instead of polling JSONL files."
        >?</span>
      </div>
      <div className="analysis-toggles">
        <label className="toggle-row" title="Periodic heartbeat analysis on a timer (not needed when hooks are installed)">
          <input
            type="checkbox"
            checked={settings.heartbeat_enabled}
            onChange={async (e) => {
              await api.updateSettings({ heartbeat_enabled: e.target.checked });
              onRefresh();
            }}
          />
          <span>Scheduled analysis</span>
        </label>
        <label className="toggle-row" title="Auto-analyze when a hook event fires (session end, etc.)">
          <input
            type="checkbox"
            checked={settings.hook_analysis_enabled}
            onChange={async (e) => {
              await api.updateSettings({ hook_analysis_enabled: e.target.checked });
              onRefresh();
            }}
          />
          <span>Hook-triggered analysis</span>
        </label>
      </div>
    </div>
  );
}
