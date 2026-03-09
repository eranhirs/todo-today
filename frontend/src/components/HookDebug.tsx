import { useState } from "react";
import { api } from "../api";

interface HookLogEntry {
  ts: string;
  session_key: string;
  hook_event: string;
  state: string | null;
  project_name: string | null;
  detail: string | null;
}

interface HookStateEntry {
  state: string;
  tool_name?: string;
  detail?: string;
  project_name?: string;
  timestamp: string;
  hook_event: string;
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function shortKey(key: string): string {
  // "encoded-dir/session-id" → last 8 chars of session id
  const parts = key.split("/");
  const sid = parts[parts.length - 1];
  return sid.length > 8 ? sid.slice(0, 8) + "..." : sid;
}

export function HookDebug() {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"log" | "states">("log");
  const [logEntries, setLogEntries] = useState<HookLogEntry[]>([]);
  const [states, setStates] = useState<Record<string, HookStateEntry>>({});
  const [loading, setLoading] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [log, events] = await Promise.all([
        api.getHookLog(50),
        api.getHookEvents(),
      ]);
      setLogEntries(log);
      setStates(events);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadData();
  };

  const stateColor = (state: string | null) => {
    if (!state) return "var(--text-dim)";
    if (state.startsWith("waiting")) return "var(--amber)";
    if (state === "ended") return "var(--green)";
    return "var(--text-dim)";
  };

  const eventColor = (event: string) => {
    if (event === "PermissionRequest") return "var(--amber)";
    if (event === "Stop" || event === "SessionEnd") return "var(--green)";
    if (event === "SessionStart") return "var(--blue)";
    return "var(--text-dim)";
  };

  return (
    <div className="hook-debug-section">
      <button className="btn-link notif-log-toggle" onClick={handleToggle}>
        {expanded ? "▾" : "▸"} Hook Debug
      </button>
      {expanded && (
        <div className="hook-debug">
          <div className="hook-debug-tabs">
            <button
              className={`hook-debug-tab ${tab === "log" ? "active" : ""}`}
              onClick={() => setTab("log")}
            >
              Event Log ({logEntries.length})
            </button>
            <button
              className={`hook-debug-tab ${tab === "states" ? "active" : ""}`}
              onClick={() => setTab("states")}
            >
              Current States ({Object.keys(states).length})
            </button>
            <button
              className="hook-debug-refresh"
              onClick={loadData}
              disabled={loading}
              title="Refresh"
            >
              {loading ? "..." : "↻"}
            </button>
          </div>

          {tab === "log" && (
            <div className="hook-debug-log">
              {logEntries.length === 0 ? (
                <div className="hook-debug-empty">No hook events recorded yet</div>
              ) : (
                <table className="hook-debug-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>State</th>
                      <th>Project</th>
                      <th>Session</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logEntries.map((e, i) => (
                      <tr key={i}>
                        <td className="hook-debug-time">{shortTime(e.ts)}</td>
                        <td style={{ color: eventColor(e.hook_event) }}>{e.hook_event}</td>
                        <td style={{ color: stateColor(e.state) }}>{e.state || "—"}</td>
                        <td>{e.project_name || "—"}</td>
                        <td className="hook-debug-session" title={e.session_key}>{shortKey(e.session_key)}</td>
                        <td className="hook-debug-detail">{e.detail || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "states" && (
            <div className="hook-debug-log">
              {Object.keys(states).length === 0 ? (
                <div className="hook-debug-empty">No active hook states</div>
              ) : (
                <table className="hook-debug-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>State</th>
                      <th>Event</th>
                      <th>Project</th>
                      <th>Session</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(states)
                      .sort(([, a], [, b]) => b.timestamp.localeCompare(a.timestamp))
                      .map(([key, s]) => (
                        <tr key={key}>
                          <td className="hook-debug-time">{shortTime(s.timestamp)}</td>
                          <td style={{ color: stateColor(s.state) }}>{s.state}</td>
                          <td style={{ color: eventColor(s.hook_event) }}>{s.hook_event}</td>
                          <td>{s.project_name || "—"}</td>
                          <td className="hook-debug-session" title={key}>{shortKey(key)}</td>
                          <td className="hook-debug-detail">
                            {s.tool_name ? `${s.tool_name}: ` : ""}
                            {s.detail || ""}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
