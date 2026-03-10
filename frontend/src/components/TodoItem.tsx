import { useState, useRef, useEffect, useMemo } from "react";
import type { Todo, TodoStatus } from "../types";
import { api } from "../api";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface Props {
  todo: Todo;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  isFocused?: boolean;
  triggerEdit?: boolean;
  projectBusy?: boolean;
}

const STATUS_OPTIONS: { value: TodoStatus; label: string; icon: string }[] = [
  { value: "next", label: "Next", icon: "→" },
  { value: "in_progress", label: "Active", icon: "●" },
  { value: "completed", label: "Done", icon: "✓" },
  { value: "consider", label: "Maybe", icon: "?" },
  { value: "waiting", label: "Wait", icon: "⏸" },
  { value: "stale", label: "Stale", icon: "✗" },
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function TodoItem({ todo, onRefresh, addToast, onOptimisticUpdate, isFocused = false, triggerEdit, projectBusy = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);
  const [showOutput, setShowOutput] = useState(false);
  const [pillsExpanded, setPillsExpanded] = useState(false);
  const [followupText, setFollowupText] = useState("");
  const pillBarRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followupRef = useRef<HTMLInputElement>(null);

  // Auto-show output while running or when interrupted (so follow-up bar is visible)
  useEffect(() => {
    if ((todo.run_status === "running" || todo.run_status === "stopped") && todo.run_output) {
      setShowOutput(true);
    }
  }, [todo.run_status, todo.run_output]);

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

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Close pill bar on outside click
  useEffect(() => {
    if (!pillsExpanded) return;
    const handler = (e: MouseEvent) => {
      if (pillBarRef.current && !pillBarRef.current.contains(e.target as Node)) {
        setPillsExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pillsExpanded]);

  // Allow parent to trigger edit mode via prop
  useEffect(() => {
    if (triggerEdit && !editing) {
      startEdit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerEdit]);

  const changeStatus = async (newStatus: TodoStatus) => {
    const prevStatus = todo.status;
    onOptimisticUpdate((todos) =>
      todos.map((t) => t.id === todo.id ? { ...t, status: newStatus } : t)
    );
    try {
      await api.updateTodo(todo.id, { status: newStatus });
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) =>
        todos.map((t) => t.id === todo.id ? { ...t, status: prevStatus } : t)
      );
      addToast(`Failed to update status for "${todo.text}"`, "error");
    }
  };

  const remove = async () => {
    onOptimisticUpdate((todos) => todos.filter((t) => t.id !== todo.id));
    try {
      await api.deleteTodo(todo.id);
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) => [...todos, todo]);
      addToast(`Failed to delete "${todo.text}"`, "error");
    }
  };

  const runWithClaude = async () => {
    try {
      const result = await api.runTodo(todo.id);
      if (result.status === "queued") {
        addToast(`Queued "${todo.text}" — will run when the current task finishes`, "info");
      } else {
        addToast(`Started running "${todo.text}" with Claude`, "info");
      }
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addToast(msg, "error");
    }
  };

  const dequeue = async () => {
    try {
      await api.dequeueTodo(todo.id);
      addToast(`Removed "${todo.text}" from queue`, "info");
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addToast(msg, "error");
    }
  };

  const stopRun = async () => {
    try {
      await api.stopTodo(todo.id);
      addToast(`Paused "${todo.text}" — use follow-up to continue`, "info");
      onRefresh();
    } catch {
      addToast(`Failed to stop "${todo.text}"`, "error");
    }
  };

  const sendFollowup = async () => {
    const msg = followupText.trim();
    if (!msg) return;
    try {
      await api.followupTodo(todo.id, msg);
      setFollowupText("");
      addToast("Follow-up sent", "info");
      onRefresh();
    } catch {
      addToast("Failed to send follow-up", "error");
    }
  };

  const startEdit = () => {
    setEditText(todo.text);
    setEditing(true);
  };

  const saveEdit = async () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== todo.text) {
      const prevText = todo.text;
      onOptimisticUpdate((todos) =>
        todos.map((t) => t.id === todo.id ? { ...t, text: trimmed } : t)
      );
      try {
        await api.updateTodo(todo.id, { text: trimmed, source: "user" });
        onRefresh();
      } catch {
        onOptimisticUpdate((todos) =>
          todos.map((t) => t.id === todo.id ? { ...t, text: prevText } : t)
        );
        addToast(`Failed to update "${prevText}"`, "error");
      }
    }
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditText(todo.text);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) {
      return; // Allow newline
    }
    if (e.key === "Enter") {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  };

  const renderedText = useMemo(() => {
    const raw = marked.parseInline(todo.text) as string;
    return DOMPurify.sanitize(raw);
  }, [todo.text]);

  const isRunning = todo.run_status === "running";
  const isQueued = todo.run_status === "queued";

  return (
    <div className={`todo-item status-${todo.status} source-${todo.source}${isRunning ? " todo-running" : ""}${isQueued ? " todo-queued" : ""}${todo.run_status === "error" ? " todo-run-error" : ""}${isFocused ? " todo-focused" : ""}`}>
      <div className="todo-content">
        <div className={`status-pills${pillsExpanded ? " expanded" : ""}`} ref={pillBarRef}>
          {STATUS_OPTIONS.map((opt) => {
            const isActive = opt.value === todo.status;
            if (!pillsExpanded && !isActive) return null;
            return (
              <button
                key={opt.value}
                className={`status-pill pill-${opt.value}${isActive ? " active" : ""}`}
                onClick={() => {
                  if (!pillsExpanded) {
                    setPillsExpanded(true);
                  } else if (!isActive) {
                    changeStatus(opt.value);
                    setPillsExpanded(false);
                  } else {
                    setPillsExpanded(false);
                  }
                }}
                title={opt.label}
              >
                <span className="pill-icon">{opt.icon}</span>
                <span className="pill-label">{opt.label}</span>
              </button>
            );
          })}
        </div>
        {editing ? (
          <textarea
            ref={inputRef}
            className="todo-text-input"
            value={editText}
            rows={Math.min(editText.split("\n").length, 6)}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="todo-text" onDoubleClick={startEdit}>
            {todo.emoji && <span className="todo-emoji">{todo.emoji}</span>}
            <span dangerouslySetInnerHTML={{ __html: renderedText }} />
          </span>
        )}
        {isRunning && <span className="run-spinner" title="Claude is working on this...">⟳</span>}
        {isQueued && <span className="queued-badge" title="Queued — waiting for current task to finish">queued</span>}
      </div>
      <div className="todo-meta">
        <span className="todo-timestamp" title={todo.created_at}>
          {formatDate(todo.created_at)} {formatTime(todo.created_at)}
        </span>
        {todo.status === "completed" && todo.completed_at && (
          <span className="todo-timestamp todo-completed-at" title={`Completed: ${todo.completed_at}`}>
            ✓ {formatTime(todo.completed_at)}
          </span>
        )}
        {todo.source === "claude" && (
          <span
            className={`badge badge-claude${todo.session_id ? " clickable" : ""}`}
            title={todo.session_id ? `Click to copy session ID: ${todo.session_id}` : "Added by Claude"}
            onClick={() => {
              if (todo.session_id) {
                navigator.clipboard.writeText(todo.session_id);
              }
            }}
          >🤖</span>
        )}
        {todo.run_trigger === "autopilot" && (
          <span className="badge badge-claude" title="Run by autopilot">🚀</span>
        )}
        {todo.run_output && (
          <button
            className="btn-icon btn-output"
            onClick={() => setShowOutput(!showOutput)}
            title="View Claude output"
          >{showOutput ? "▾" : "▸"}</button>
        )}
        {todo.run_status === "error" && <span className="badge-run-error" title="Run failed">err</span>}
        {isRunning ? (
          <button
            className="btn-icon btn-stop"
            onClick={stopRun}
            title="Pause — interrupt and continue via follow-up"
          >■</button>
        ) : isQueued ? (
          <button
            className="btn-icon btn-dequeue"
            onClick={dequeue}
            title="Remove from queue"
          >✗</button>
        ) : (
          <button
            className="btn-icon btn-run"
            onClick={runWithClaude}
            title={projectBusy ? "Will be queued — another task is running" : "Run with Claude"}
          >▶</button>
        )}
        <button className="btn-icon btn-delete" onClick={remove} title="Delete">×</button>
      </div>
      {showOutput && todo.run_output && (
        <div className="run-output">
          <pre ref={outputRef}>{todo.run_output}</pre>
        </div>
      )}
      {showOutput && todo.session_id && !isRunning && (todo.run_status === "done" || todo.run_status === "error" || todo.run_status === "stopped") && (
        <div className="followup-bar">
          <input
            ref={followupRef}
            className="followup-input"
            placeholder={todo.run_status === "stopped" ? "Continue this session..." : "Send follow-up to this session..."}
            value={followupText}
            onChange={(e) => setFollowupText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendFollowup();
              }
            }}
          />
          <button className="btn-icon btn-run" onClick={sendFollowup} title="Send follow-up">↵</button>
        </div>
      )}
    </div>
  );
}
