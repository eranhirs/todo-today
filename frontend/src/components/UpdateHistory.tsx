import { useState } from "react";
import type { AnalysisEntry } from "../types";

interface Props {
  history: AnalysisEntry[];
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
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
      {entry.completed_todo_texts?.length > 0 && (
        <div className="history-detail-section">
          <strong>Marked done ({entry.completed_todo_texts.length}):</strong>
          <ul>{entry.completed_todo_texts.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {entry.added_todos_active?.length > 0 && (
        <div className="history-detail-section">
          <strong>Added — next steps ({entry.added_todos_active.length}):</strong>
          <ul>{entry.added_todos_active.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {entry.added_todos_completed?.length > 0 && (
        <div className="history-detail-section">
          <strong>Added — done ({entry.added_todos_completed.length}):</strong>
          <ul>{entry.added_todos_completed.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {entry.modified_todos?.length > 0 && (
        <div className="history-detail-section">
          <strong>Modified ({entry.modified_todos.length}):</strong>
          <ul>{entry.modified_todos.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {entry.new_project_names?.length > 0 && (
        <div className="history-detail-section">
          <strong>New projects:</strong> {entry.new_project_names.join(", ")}
        </div>
      )}
      {entry.insights?.length > 0 && (
        <div className="history-detail-section history-insights">
          <strong>Insights:</strong>
          <ul>{entry.insights.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
        {entry.prompt_text && (
          <CopyButton label="Copy Prompt" text={entry.prompt_text} />
        )}
        {entry.claude_reasoning && (
          <CopyButton label="Copy Reasoning" text={entry.claude_reasoning} />
        )}
        {entry.claude_response && (
          <CopyButton label="Copy Response" text={entry.claude_response} />
        )}
        <CopyButton
          label="Copy Raw JSON"
          text={JSON.stringify({ ...entry, prompt_text: `(${entry.prompt_text?.length ?? 0} chars)`, claude_response: `(${entry.claude_response?.length ?? 0} chars)`, claude_reasoning: `(${entry.claude_reasoning?.length ?? 0} chars)` }, null, 2)}
        />
      </div>
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
          {history.map((entry, i) => {
            const activeCount = entry.added_todos_active?.length ?? 0;
            const doneCount = entry.added_todos_completed?.length ?? 0;
            const markedDone = entry.completed_todo_texts?.length ?? entry.todos_completed;
            const modified = entry.todos_modified;

            const statParts: string[] = [];
            if (activeCount > 0) statParts.push(`+${activeCount} active`);
            if (doneCount > 0) statParts.push(`+${doneCount} done`);
            if (markedDone > 0) statParts.push(`${markedDone} marked done`);
            if (modified > 0) statParts.push(`${modified} modified`);

            return (
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
                  Sessions: {entry.sessions_analyzed}
                  {statParts.length > 0 && ` | ${statParts.join(" | ")}`}
                </div>
                {expandedEntry === i && <EntryDetail entry={entry} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
