import { useState, useRef, useEffect, useMemo } from "react";
import type { Todo, TodoStatus } from "../types";
import { api } from "../api";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { TodoRunControls } from "./TodoRunControls";
import { TodoOutput } from "./TodoOutput";
import { parseTags, stripTagsFromText } from "../utils/tags";

interface Props {
  todo: Todo;
  allTags?: string[];
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  isFocused?: boolean;
  triggerEdit?: boolean;
  projectBusy?: boolean;
  atRunQuotaLimit?: boolean;
  quotaCountdown?: string;
  disabled?: boolean;
  onOutputOpen?: (todoId: string) => void;
}

const STATUS_OPTIONS: { value: TodoStatus; label: string; icon: string }[] = [
  { value: "next", label: "Next", icon: "→" },
  { value: "in_progress", label: "Active", icon: "●" },
  { value: "completed", label: "Done", icon: "✓" },
  { value: "consider", label: "Maybe", icon: "?" },
  { value: "waiting", label: "Wait", icon: "⏸" },
  { value: "stale", label: "Stale", icon: "✗" },
  { value: "rejected", label: "Rejected", icon: "⊘" },
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export function TodoItem({ todo, allTags = [], onRefresh, addToast, onOptimisticUpdate, isFocused = false, triggerEdit, projectBusy = false, atRunQuotaLimit = false, quotaCountdown = "", disabled = false, onOutputOpen }: Props) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);
  const [showOutput, setShowOutput] = useState(false);
  const [pillsExpanded, setPillsExpanded] = useState(false);
  const [editTagSuggestions, setEditTagSuggestions] = useState<string[]>([]);
  const [editSelectedSuggestion, setEditSelectedSuggestion] = useState(0);
  const pillBarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [, setTick] = useState(0);

  const isActive = !["completed", "rejected", "stale"].includes(todo.status);

  // Tick every 60s to keep relative timestamps fresh
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [isActive]);

  // Auto-show output while running or when interrupted (so follow-up bar is visible)
  useEffect(() => {
    if ((todo.run_status === "running" || todo.run_status === "stopped") && todo.run_output) {
      setShowOutput(true);
    }
  }, [todo.run_status, todo.run_output]);

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

  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isExpandable = !!(todo.run_output || todo.original_text || (todo.images && todo.images.length > 0));

  const handleTextClick = async () => {
    if (clickTimer.current) {
      // Double-click detected — cancel single-click action
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      return;
    }
    clickTimer.current = setTimeout(async () => {
      clickTimer.current = null;
      if (!isExpandable) return;
      const willShow = !showOutput;
      setShowOutput(willShow);
      if (willShow) {
        onOutputOpen?.(todo.id);
        if (!todo.is_read && todo.completed_by_run) {
          onOptimisticUpdate((todos) =>
            todos.map((t) => t.id === todo.id ? { ...t, is_read: true } : t)
          );
          try {
            await api.updateTodo(todo.id, { is_read: true });
            onRefresh();
          } catch { /* silent — not critical */ }
        }
      }
    }, 250);
  };

  const handleTextDoubleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    startEdit();
  };

  const isPending = todo.id.startsWith("temp-");

  const changeStatus = async (newStatus: TodoStatus) => {
    if (disabled) {
      addToast("You're offline — status changes aren't available right now", "warning");
      return;
    }
    const prevStatus = todo.status;
    const prevReason = todo.stale_reason;
    onOptimisticUpdate((todos) =>
      todos.map((t) => t.id === todo.id ? { ...t, status: newStatus, stale_reason: newStatus === "stale" ? t.stale_reason : null } : t)
    );
    try {
      await api.updateTodo(todo.id, { status: newStatus });
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) =>
        todos.map((t) => t.id === todo.id ? { ...t, status: prevStatus, stale_reason: prevReason } : t)
      );
      addToast(`Failed to update status for "${todo.text}"`, "error");
    }
  };

  const remove = async () => {
    if (disabled) {
      addToast("You're offline — deleting items isn't available right now", "warning");
      return;
    }
    onOptimisticUpdate((todos) => todos.filter((t) => t.id !== todo.id));
    try {
      await api.deleteTodo(todo.id);
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) => [...todos, todo]);
      addToast(`Failed to delete "${todo.text}"`, "error");
    }
  };

  const unpinOrder = async () => {
    if (disabled) {
      addToast("You're offline — changes aren't available right now", "warning");
      return;
    }
    onOptimisticUpdate((todos) =>
      todos.map((t) => t.id === todo.id ? { ...t, user_ordered: false } : t)
    );
    try {
      await api.updateTodo(todo.id, { user_ordered: false });
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) =>
        todos.map((t) => t.id === todo.id ? { ...t, user_ordered: true } : t)
      );
      addToast(`Failed to unpin order for "${todo.text}"`, "error");
    }
  };

  const startEdit = () => {
    if (disabled) {
      addToast("You're offline — editing isn't available right now", "warning");
      return;
    }
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

  // Compute tag suggestions for edit mode
  const computeEditTagSuggestions = (value: string) => {
    const el = inputRef.current;
    if (!el || allTags.length === 0) { setEditTagSuggestions([]); return; }
    const cursorPos = el.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursorPos);
    const match = beforeCursor.match(/(?:^|\s)#([A-Za-z][A-Za-z0-9_-]*)$/);
    const hashMatch = beforeCursor.match(/(?:^|\s)#$/);
    const fragment = match ? match[1].toLowerCase() : hashMatch ? "" : null;
    if (fragment === null) { setEditTagSuggestions([]); return; }
    setEditTagSuggestions(allTags.filter((t) => fragment === "" || t.startsWith(fragment)));
    setEditSelectedSuggestion(0);
  };

  const applyEditSuggestion = (tag: string) => {
    const el = inputRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart ?? editText.length;
    const beforeCursor = editText.slice(0, cursorPos);
    const afterCursor = editText.slice(cursorPos);
    const hashIdx = beforeCursor.lastIndexOf("#");
    if (hashIdx === -1) return;
    const newText = beforeCursor.slice(0, hashIdx) + "#" + tag + " " + afterCursor;
    setEditText(newText);
    setEditTagSuggestions([]);
    setTimeout(() => {
      el.focus();
      const newPos = hashIdx + 1 + tag.length + 1;
      el.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle tag suggestion navigation in edit mode
    if (editTagSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEditSelectedSuggestion((s) => Math.min(s + 1, editTagSuggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEditSelectedSuggestion((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        if (editTagSuggestions[editSelectedSuggestion]) {
          e.preventDefault();
          applyEditSuggestion(editTagSuggestions[editSelectedSuggestion]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditTagSuggestions([]);
        return;
      }
    }
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

  const tags = useMemo(() => parseTags(todo.text), [todo.text]);

  const renderedText = useMemo(() => {
    const displayText = stripTagsFromText(todo.text);
    const raw = marked.parseInline(displayText) as string;
    return DOMPurify.sanitize(raw);
  }, [todo.text]);

  const isRunning = todo.run_status === "running";
  const isQueued = todo.run_status === "queued";

  return (
    <div className={`todo-item status-${todo.status} source-${todo.source}${isRunning ? " todo-running" : ""}${isQueued ? " todo-queued" : ""}${todo.run_status === "error" ? " todo-run-error" : ""}${isFocused ? " todo-focused" : ""}${isPending ? " todo-pending" : ""}`}>
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
          <div className="todo-edit-wrapper">
            <textarea
              ref={inputRef}
              className="todo-text-input"
              value={editText}
              rows={Math.min(editText.split("\n").length, 6)}
              onChange={(e) => { setEditText(e.target.value); computeEditTagSuggestions(e.target.value); }}
              onBlur={() => { if (editTagSuggestions.length === 0) saveEdit(); }}
              onKeyDown={handleKeyDown}
            />
            {editTagSuggestions.length > 0 && (
              <div className="tag-suggestions">
                {editTagSuggestions.map((tag, i) => (
                  <button
                    key={tag}
                    className={`tag-suggestion-item${i === editSelectedSuggestion ? " selected" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); applyEditSuggestion(tag); }}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="todo-text" onClick={handleTextClick} onDoubleClick={handleTextDoubleClick} style={{ cursor: isExpandable ? "pointer" : undefined }}>
            {todo.emoji && <span className="todo-emoji">{todo.emoji}</span>}
            <span dangerouslySetInnerHTML={{ __html: renderedText }} />
          </span>
        )}
        {tags.length > 0 && (
          <span className="todo-tags">
            {tags.map((tag) => (
              <span key={tag} className="tag-pill">#{tag}</span>
            ))}
          </span>
        )}
        {isPending && <span className="pending-badge" title="Not sent — added while offline">not sent</span>}
        {todo.plan_only && <span className="plan-only-badge" title="Plan only — agent will plan but not implement">plan</span>}
        {todo.user_ordered && <span className="pinned-badge" title="Pinned order — you manually reordered this item">📌</span>}
        {isRunning && <span className="run-spinner" title={todo.plan_only ? "Claude is planning this..." : "Claude is working on this..."}>⟳</span>}
        {isQueued && <span className="queued-badge" title="Queued — waiting for current task to finish">queued</span>}
      </div>
      <div className="todo-meta">
        {todo.images && todo.images.length > 0 && (
          <span className="badge badge-images" title={`${todo.images.length} image${todo.images.length > 1 ? "s" : ""} attached`}>
            🖼 {todo.images.length}
          </span>
        )}
        <span className="todo-timestamp" title={todo.created_at}>
          {isActive ? (
            <span className="time-ago">{timeAgo(todo.created_at)}</span>
          ) : (
            <>{formatDate(todo.created_at)} {formatTime(todo.created_at)}</>
          )}
        </span>
        {todo.status === "completed" && todo.completed_at && (
          <span className="todo-timestamp todo-completed-at" title={`Completed: ${todo.completed_at}`}>
            ✓ {formatTime(todo.completed_at)}
          </span>
        )}
        {todo.source === "claude" && (
          <span
            className={`badge badge-source${todo.session_id ? " clickable" : ""}`}
            title={
              todo.session_id
                ? `Added by Claude — click to copy session ID: ${todo.session_id}`
                : "Added by Claude"
            }
            onClick={() => {
              if (todo.session_id) {
                navigator.clipboard.writeText(todo.session_id);
              }
            }}
          >🤖</span>
        )}
        {todo.completed_by_run && (
          <button
            className={`badge badge-run badge-read-toggle${todo.is_read ? " is-read" : ""}`}
            title={todo.is_read ? "Mark as unread" : "Mark as read"}
            onClick={async (e) => {
              e.stopPropagation();
              const newVal = !todo.is_read;
              onOptimisticUpdate((todos) =>
                todos.map((t) => t.id === todo.id ? { ...t, is_read: newVal } : t)
              );
              try {
                await api.updateTodo(todo.id, { is_read: newVal });
                onRefresh();
              } catch {
                onOptimisticUpdate((todos) =>
                  todos.map((t) => t.id === todo.id ? { ...t, is_read: !newVal } : t)
                );
                addToast("Failed to toggle read status", "error");
              }
            }}
          >⚡</button>
        )}
        {todo.run_trigger === "autopilot" && (
          <span className="badge badge-autopilot" title="Run by autopilot">🚀</span>
        )}
        {todo.red_flags && todo.red_flags.length > 0 && (
          <span
            className="badge badge-red-flags"
            title={todo.red_flags.map((f) => f.label).join(", ")}
            onClick={(e) => { e.stopPropagation(); setShowOutput(true); }}
          >
            {todo.red_flags.length} red flag{todo.red_flags.length > 1 ? "s" : ""}
          </span>
        )}
        {todo.run_status === "error" && <span className="badge-run-error" title="Run failed">err</span>}
        <TodoRunControls todo={todo} onRefresh={onRefresh} addToast={addToast} projectBusy={projectBusy} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={disabled} />
        {todo.user_ordered && (
          <button className="btn-icon btn-unpin" onClick={unpinOrder} title="Unpin order — let the system reorder this item">📌</button>
        )}
        <button className="btn-icon btn-delete" onClick={remove} title="Delete">×</button>
      </div>
      {showOutput && todo.images && todo.images.length > 0 && (
        <div className="todo-images">
          {todo.images.map((filename, idx) => (
            <a key={filename} href={api.imageUrl(filename)} target="_blank" rel="noopener noreferrer" className="todo-image-thumb">
              <img src={api.imageUrl(filename)} alt={`Attachment ${idx + 1}`} />
            </a>
          ))}
        </div>
      )}
      {todo.status === "stale" && todo.stale_reason && (
        <span className="stale-reason">{todo.stale_reason}</span>
      )}
      {showOutput && todo.original_text && (
        <div className="todo-original-text">
          <span className="todo-original-label">Original:</span> {todo.original_text}
        </div>
      )}
      <TodoOutput todo={todo} showOutput={showOutput} onRefresh={onRefresh} addToast={addToast} disabled={disabled} />
    </div>
  );
}
