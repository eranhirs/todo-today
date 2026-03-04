import { useState } from "react";
import type { AnalysisEntry } from "../types";

interface Props {
  history: AnalysisEntry[];
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function EntryDetail({ entry }: { entry: AnalysisEntry }) {
  return (
    <div className="history-detail">
      <div className="history-detail-row">
        Cost: ${entry.cost_usd.toFixed(4)} | Tokens: {formatTokens(entry.input_tokens)} in / {formatTokens(entry.output_tokens)} out / {formatTokens(entry.cache_read_tokens)} cache
      </div>
      <div className="history-detail-row">
        Duration: {entry.duration_seconds}s | Prompt: {formatTokens(entry.prompt_length)} chars
      </div>
      {entry.error && (
        <div className="history-detail-error">Error: {entry.error}</div>
      )}
      {entry.completed_todo_ids.length > 0 && (
        <div className="history-detail-section">
          <strong>Completed ({entry.completed_todo_ids.length}):</strong>
          <ul>{entry.completed_todo_ids.map((id) => <li key={id}>{id}</li>)}</ul>
        </div>
      )}
      {entry.added_todos.length > 0 && (
        <div className="history-detail-section">
          <strong>Added ({entry.added_todos.length}):</strong>
          <ul>{entry.added_todos.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {entry.new_project_names.length > 0 && (
        <div className="history-detail-section">
          <strong>New projects:</strong> {entry.new_project_names.join(", ")}
        </div>
      )}
    </div>
  );
}

export function UpdateHistory({ history }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);

  if (history.length === 0) return null;

  return (
    <div className="update-history">
      <button className="btn-link" onClick={() => setExpanded(!expanded)}>
        {expanded ? "▾" : "▸"} Analysis History ({history.length})
      </button>
      {expanded && (
        <div className="history-list">
          {history.map((entry, i) => (
            <div
              key={i}
              className={`history-entry ${expandedEntry === i ? "history-entry-expanded" : ""}`}
              onClick={() => setExpandedEntry(expandedEntry === i ? null : i)}
            >
              <div className="history-time">
                {new Date(entry.timestamp).toLocaleString()}
                <span className="history-duration">({entry.duration_seconds}s)</span>
                {entry.cost_usd > 0 && <span className="history-cost">${entry.cost_usd.toFixed(4)}</span>}
                {entry.error && <span className="history-error-badge">error</span>}
              </div>
              <div className="history-summary">{entry.summary}</div>
              <div className="history-stats">
                Sessions: {entry.sessions_analyzed} | +{entry.todos_added} added | {entry.todos_completed} completed
              </div>
              {expandedEntry === i && <EntryDetail entry={entry} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
