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

export function TodoOutput({ todo, showOutput, onRefresh, addToast, disabled = false }: Props) {
  const [followupText, setFollowupText] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);
  const followupRef = useRef<HTMLInputElement>(null);

  const isRunning = todo.run_status === "running";
  const showFollowup = todo.session_id && !isRunning &&
    (todo.run_status === "done" || todo.run_status === "error" || todo.run_status === "stopped");

  // Auto-scroll output to bottom as it streams
  useEffect(() => {
    if (showOutput && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [showOutput, todo.run_output]);

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

  if (!showOutput) return null;

  return (
    <>
      {todo.run_output && (
        <div
          className="run-output"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <pre ref={outputRef}>{todo.run_output}</pre>
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
