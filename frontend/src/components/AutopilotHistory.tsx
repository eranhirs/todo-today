import { useState } from "react";
import type { Todo, Project } from "../types";

interface Props {
  todos: Todo[];
  projects: Project[];
  selectedProjectId: string | null;
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button className="btn-link" style={{ fontSize: "0.65rem" }} onClick={copy}>
      {copied ? "Copied!" : label}
    </button>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function AutopilotHistory({ todos, projects, selectedProjectId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
  const [showFullOutput, setShowFullOutput] = useState<Set<string>>(new Set());

  const projectMap = new Map(projects.map((p) => [p.id, p.name]));

  const runTodos = todos
    .filter((t) => t.run_status !== null)
    .filter((t) => !selectedProjectId || t.project_id === selectedProjectId)
    .sort((a, b) => {
      const ta = a.completed_at || a.created_at;
      const tb = b.completed_at || b.created_at;
      return tb.localeCompare(ta);
    });

  if (runTodos.length === 0) return null;

  const toggleFullOutput = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setShowFullOutput((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="autopilot-history">
      <button className="btn-link" onClick={() => setExpanded(!expanded)}>
        {expanded ? "▾" : "▸"} Autopilot History ({runTodos.length})
      </button>
      {expanded && (
        <div className="history-list">
          {runTodos.map((todo) => {
            const isExpanded = expandedEntry === todo.id;
            const timestamp = todo.completed_at || todo.created_at;
            const output = todo.run_output || "";
            const OUTPUT_LIMIT = 500;
            const isLong = output.length > OUTPUT_LIMIT;
            const showFull = showFullOutput.has(todo.id);

            return (
              <div
                key={todo.id}
                className={`history-entry ${isExpanded ? "history-entry-expanded" : ""}`}
                onClick={() => setExpandedEntry(isExpanded ? null : todo.id)}
              >
                <div className="history-time">
                  {formatTime(timestamp)}
                  <span className={`autopilot-status-badge status-${todo.run_status}`}>
                    {todo.run_status}
                  </span>
                  <span className={`autopilot-source-badge source-${todo.run_trigger || "manual"}`}>
                    {todo.run_trigger || "manual"}
                  </span>
                </div>
                <div className="history-summary">{truncate(todo.text, 80)}</div>
                <div className="history-stats">
                  {projectMap.get(todo.project_id) || "unknown"}
                  {todo.session_id && (
                    <>
                      {" | "}
                      <CopyButton
                        label={todo.session_id.slice(0, 8)}
                        text={todo.session_id}
                      />
                    </>
                  )}
                </div>
                {isExpanded && output && (
                  <div className="run-output" onClick={(e) => e.stopPropagation()}>
                    <pre>{showFull ? output : output.slice(0, OUTPUT_LIMIT)}{isLong && !showFull ? "…" : ""}</pre>
                    <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                      {isLong && (
                        <button
                          className="btn-link"
                          style={{ fontSize: "0.65rem" }}
                          onClick={(e) => toggleFullOutput(todo.id, e)}
                        >
                          {showFull ? "Show less" : "Show more"}
                        </button>
                      )}
                      <CopyButton label="Copy Output" text={output} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
