import { useState, useRef, useEffect } from "react";
import type { Todo } from "../types";
import { api } from "../api";

interface Props {
  todo: Todo;
  showOutput: boolean;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  disabled?: boolean;
}

const FOLLOWUP_RE = /\n\n--- (?:Follow-up(?: \(queued\))?|BTW) ---\n\*\*You:\*\* /;

function renderOutput(text: string) {
  const parts = text.split(FOLLOWUP_RE);
  if (parts.length === 1) return text;

  const elements: (string | React.ReactElement)[] = [parts[0]];
  // After each split point, we have the user's message + rest of output
  let matchIndex = 0;
  let searchFrom = 0;
  for (let i = 1; i < parts.length; i++) {
    // Find which variant matched so we can reconstruct the header
    const queuedMatch = text.indexOf("\n\n--- Follow-up (queued) ---\n**You:** ", searchFrom);
    const normalMatch = text.indexOf("\n\n--- Follow-up ---\n**You:** ", searchFrom);
    const btwMatch = text.indexOf("\n\n--- BTW ---\n**You:** ", searchFrom);

    // Find the earliest match among all variants
    const candidates = [
      { pos: queuedMatch, header: "Follow-up (queued)", full: "\n\n--- Follow-up (queued) ---\n**You:** " },
      { pos: normalMatch, header: "Follow-up", full: "\n\n--- Follow-up ---\n**You:** " },
      { pos: btwMatch, header: "BTW", full: "\n\n--- BTW ---\n**You:** " },
    ].filter(c => c.pos !== -1);
    candidates.sort((a, b) => a.pos - b.pos);
    const match = candidates[0];

    const headerText = match.header;
    searchFrom = match.pos + match.full.length;

    // Split the part into the user message (first line) and rest
    const newlineIdx = parts[i].indexOf("\n");
    const userMsg = newlineIdx === -1 ? parts[i] : parts[i].slice(0, newlineIdx);
    const rest = newlineIdx === -1 ? "" : parts[i].slice(newlineIdx);

    elements.push(
      <span key={`followup-${matchIndex}`} className="followup-marker">
        {"\n\n"}
        <span className="followup-header">{"── " + headerText + " ──"}</span>
        {"\n"}
        <span className="followup-user-msg">{"▶ You: " + userMsg}</span>
      </span>
    );
    if (rest) elements.push(rest);
    matchIndex++;
  }
  return <>{elements}</>;
}

function renderBtwOutput(text: string) {
  const match = text.match(/^\*\*You:\*\* (.+)\n/);
  if (!match) return text;
  const userMsg = match[1];
  const rest = text.slice(match[0].length);
  return (
    <>
      <span className="followup-marker">
        <span className="followup-header">{"── BTW ──"}</span>
        {"\n"}
        <span className="followup-user-msg">{"▶ You: " + userMsg}</span>
      </span>
      {rest ? "\n" + rest : ""}
    </>
  );
}

type OutputTab = "run" | "btw";

export function TodoOutput({ todo, showOutput, onRefresh, addToast, disabled = false }: Props) {
  const [followupText, setFollowupText] = useState("");
  const [btwText, setBtwText] = useState("");
  const [activeTab, setActiveTab] = useState<OutputTab>("run");
  const outputRef = useRef<HTMLPreElement>(null);
  const btwOutputRef = useRef<HTMLPreElement>(null);
  const followupRef = useRef<HTMLInputElement>(null);

  const isRunning = todo.run_status === "running";
  const showFollowup = todo.session_id && !isRunning &&
    (todo.run_status === "done" || todo.run_status === "error" || todo.run_status === "stopped");
  const showBtw = isRunning;
  const hasBtwOutput = !!todo.btw_output;
  const isBtwRunning = todo.btw_status === "running";

  // Auto-switch to btw tab when a new btw starts
  useEffect(() => {
    if (isBtwRunning && showOutput) {
      setActiveTab("btw");
    }
  }, [isBtwRunning, showOutput]);

  // Auto-scroll output to bottom as it streams
  useEffect(() => {
    if (showOutput && activeTab === "run" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [showOutput, activeTab, todo.run_output]);

  // Auto-scroll btw output
  useEffect(() => {
    if (showOutput && activeTab === "btw" && btwOutputRef.current) {
      btwOutputRef.current.scrollTop = btwOutputRef.current.scrollHeight;
    }
  }, [showOutput, activeTab, todo.btw_output]);

  // Auto-focus follow-up input when interrupted
  useEffect(() => {
    if (todo.run_status === "stopped" && showOutput && followupRef.current) {
      followupRef.current.focus();
    }
  }, [todo.run_status, showOutput]);

  const sendFollowup = async () => {
    if (disabled) {
      addToast("You're offline — follow-ups aren't available right now", "warning");
      return;
    }
    const msg = followupText.trim();
    if (!msg) return;
    try {
      const result = await api.followupTodo(todo.id, msg);
      setFollowupText("");
      if (result.status === "queued") {
        addToast("Follow-up queued — will run when the current task finishes", "info");
      } else {
        addToast("Follow-up sent", "info");
      }
      onRefresh();
    } catch {
      addToast("Failed to send follow-up", "error");
    }
  };

  const sendBtw = async () => {
    if (disabled) {
      addToast("You're offline — btw messages aren't available right now", "warning");
      return;
    }
    const msg = btwText.trim();
    if (!msg) return;
    try {
      await api.btwTodo(todo.id, msg);
      setBtwText("");
      addToast("/btw started — running in parallel", "info");
      onRefresh();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Failed to send /btw";
      addToast(detail, "error");
    }
  };

  if (!showOutput) return null;

  const showTabs = hasBtwOutput;

  return (
    <>
      {/* Tab bar — only shown when btw output exists */}
      {showTabs && (
        <div
          className="output-tabs"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button
            className={`output-tab${activeTab === "run" ? " active" : ""}`}
            onClick={() => setActiveTab("run")}
          >
            Run
          </button>
          <button
            className={`output-tab${activeTab === "btw" ? " active" : ""}${isBtwRunning ? " tab-running" : ""}`}
            onClick={() => setActiveTab("btw")}
          >
            /btw{isBtwRunning ? " ⟳" : ""}
            {todo.btw_status === "error" && " ✗"}
          </button>
        </div>
      )}

      {/* Run output tab */}
      {(!showTabs || activeTab === "run") && todo.run_output && (
        <div
          className="run-output"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <pre ref={outputRef}>{renderOutput(todo.run_output)}</pre>
        </div>
      )}

      {/* BTW output tab */}
      {showTabs && activeTab === "btw" && todo.btw_output && (
        <div
          className="run-output btw-output"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <pre ref={btwOutputRef}>{renderBtwOutput(todo.btw_output)}</pre>
        </div>
      )}

      {/* BTW input bar — shown when main run is active */}
      {showBtw && (
        <div className="followup-bar btw-bar" draggable={false} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          <input
            className="followup-input"
            placeholder={disabled ? "Server offline — changes disabled" : isBtwRunning ? "/btw running — wait for it to finish..." : "/btw — side-channel request (runs in parallel)..."}
            value={btwText}
            disabled={disabled || isBtwRunning}
            onChange={(e) => setBtwText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendBtw();
              }
            }}
          />
          <button className="btn-icon btn-run" onClick={sendBtw} disabled={disabled || isBtwRunning} title="Send /btw">↵</button>
        </div>
      )}
      {showFollowup && (
        <div className="followup-bar" draggable={false} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          <input
            ref={followupRef}
            className="followup-input"
            placeholder={disabled ? "Server offline — changes disabled" : todo.run_status === "stopped" ? "Continue this session..." : "Send follow-up to this session..."}
            value={followupText}
            disabled={disabled}
            onChange={(e) => setFollowupText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendFollowup();
              }
            }}
          />
          <button className="btn-icon btn-run" onClick={sendFollowup} disabled={disabled} title="Send follow-up">↵</button>
        </div>
      )}
    </>
  );
}
