import { useState, useRef, useEffect, useMemo } from "react";
import { isUnread, type Todo, type TodoStatus } from "../types";
import { api } from "../api";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { TodoRunControls } from "./TodoRunControls";
import { TodoOutput } from "./TodoOutput";
import { parseTags, stripTagsFromText } from "../utils/tags";
import { type CommandInfo, stripCommandsFromText } from "../utils/commands";
import { filterMentionSuggestions } from "../utils/todoSearch";

interface Props {
  todo: Todo;
  allTags?: string[];
  allTodos?: Todo[];
  allCommands?: CommandInfo[];
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error", options?: { onUndo?: () => void; duration?: number }) => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  isFocused?: boolean;
  triggerEdit?: boolean;
  projectBusy?: boolean;
  atRunQuotaLimit?: boolean;
  quotaCountdown?: string;
  disabled?: boolean;
  sourcePath?: string;
  onOutputOpen?: (todoId: string) => void;
  addPendingDelete?: (id: string) => void;
  removePendingDelete?: (id: string) => void;
  addOptimisticOverride?: (id: string, fields: Partial<Todo>) => void;
  removeOptimisticOverride?: (id: string) => void;
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

export function TodoItem({ todo, allTags = [], allTodos = [], allCommands, onRefresh, addToast, onOptimisticUpdate, isFocused = false, triggerEdit, projectBusy = false, atRunQuotaLimit = false, quotaCountdown = "", disabled = false, sourcePath = "", onOutputOpen, addPendingDelete, removePendingDelete, addOptimisticOverride, removeOptimisticOverride }: Props) {
  const commands = allCommands ?? [];
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);
  const [showOutput, setShowOutput] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [pillsExpanded, setPillsExpanded] = useState(false);
  const [editTagSuggestions, setEditTagSuggestions] = useState<string[]>([]);
  const [editCmdSuggestions, setEditCmdSuggestions] = useState<CommandInfo[]>([]);
  const [editMentionSuggestions, setEditMentionSuggestions] = useState<Todo[]>([]);
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

  // Auto-show output when a todo transitions to running or stopped (so follow-up bar
  // is visible), but NOT on initial mount — avoids completed/stopped todos re-expanding
  // their output every time the component mounts (e.g., when switching projects).
  const prevRunStatusRef = useRef(todo.run_status);
  useEffect(() => {
    const prev = prevRunStatusRef.current;
    prevRunStatusRef.current = todo.run_status;
    if (prev === todo.run_status) return; // no transition
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

  const isExpandable = !!(todo.run_output || todo.original_text || todo.plan_file || (todo.images && todo.images.length > 0));

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
        if (isUnread(todo)) {
          addOptimisticOverride?.(todo.id, { is_read: true });
          onOptimisticUpdate((todos) =>
            todos.map((t) => t.id === todo.id ? { ...t, is_read: true } : t)
          );
          try {
            await api.updateTodo(todo.id, { is_read: true });
            removeOptimisticOverride?.(todo.id);
            onRefresh();
          } catch {
            removeOptimisticOverride?.(todo.id);
            /* silent — not critical */
          }
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
    const override = { status: newStatus, stale_reason: newStatus === "stale" ? todo.stale_reason : null } as Partial<Todo>;
    addOptimisticOverride?.(todo.id, override);
    onOptimisticUpdate((todos) =>
      todos.map((t) => t.id === todo.id ? { ...t, ...override } : t)
    );
    try {
      await api.updateTodo(todo.id, { status: newStatus });
      removeOptimisticOverride?.(todo.id);
      onRefresh();
    } catch {
      removeOptimisticOverride?.(todo.id);
      onOptimisticUpdate((todos) =>
        todos.map((t) => t.id === todo.id ? { ...t, status: prevStatus, stale_reason: prevReason } : t)
      );
      addToast(`Failed to update status for "${todo.text}"`, "error");
    }
  };

  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remove = () => {
    if (disabled) {
      addToast("You're offline — deleting items isn't available right now", "warning");
      return;
    }
    // Optimistically hide the item immediately and mark as pending delete
    // so polling doesn't bring it back during the undo window
    const snapshot = { ...todo };
    addPendingDelete?.(snapshot.id);
    onOptimisticUpdate((todos) => todos.filter((t) => t.id !== todo.id));

    let undone = false;
    const UNDO_DELAY = 5_000;

    const doDelete = async () => {
      if (undone) return;
      removePendingDelete?.(snapshot.id);
      try {
        await api.deleteTodo(snapshot.id);
        onRefresh();
      } catch {
        onOptimisticUpdate((todos) => [...todos, snapshot]);
        addToast(`Failed to delete "${snapshot.text}"`, "error");
      }
    };

    // Schedule actual deletion after delay
    deleteTimerRef.current = setTimeout(doDelete, UNDO_DELAY);

    const displayText = stripCommandsFromText(stripTagsFromText(snapshot.text)).trim();
    const label = displayText.length > 40 ? displayText.slice(0, 40) + "…" : displayText;

    addToast(`Deleted "${label}"`, "info", {
      duration: UNDO_DELAY,
      onUndo: () => {
        undone = true;
        if (deleteTimerRef.current) {
          clearTimeout(deleteTimerRef.current);
          deleteTimerRef.current = null;
        }
        // Remove from pending deletes and restore the item
        removePendingDelete?.(snapshot.id);
        onOptimisticUpdate((todos) => [...todos, snapshot]);
        onRefresh();
      },
    });
  };

  const unpinOrder = async () => {
    if (disabled) {
      addToast("You're offline — changes aren't available right now", "warning");
      return;
    }
    addOptimisticOverride?.(todo.id, { user_ordered: false });
    onOptimisticUpdate((todos) =>
      todos.map((t) => t.id === todo.id ? { ...t, user_ordered: false } : t)
    );
    try {
      await api.updateTodo(todo.id, { user_ordered: false });
      removeOptimisticOverride?.(todo.id);
      onRefresh();
    } catch {
      removeOptimisticOverride?.(todo.id);
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
      addOptimisticOverride?.(todo.id, { text: trimmed });
      onOptimisticUpdate((todos) =>
        todos.map((t) => t.id === todo.id ? { ...t, text: trimmed } : t)
      );
      try {
        await api.updateTodo(todo.id, { text: trimmed, source: "user" });
        removeOptimisticOverride?.(todo.id);
        onRefresh();
      } catch {
        removeOptimisticOverride?.(todo.id);
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

  // Compute tag, command, and mention suggestions for edit mode
  const computeEditSuggestions = (value: string) => {
    const el = inputRef.current;
    if (!el) { setEditTagSuggestions([]); setEditCmdSuggestions([]); setEditMentionSuggestions([]); return; }
    const cursorPos = el.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursorPos);

    // Check for command fragment first
    const cmdMatch = beforeCursor.match(/(?:^|\s)\/([A-Za-z][A-Za-z0-9_-]*)$/);
    const slashMatch = beforeCursor.match(/(?:^|\s)\/$/);
    const cmdFragment = cmdMatch ? cmdMatch[1].toLowerCase() : slashMatch ? "" : null;
    if (cmdFragment !== null) {
      setEditTagSuggestions([]);
      setEditMentionSuggestions([]);
      setEditCmdSuggestions(commands.filter((c) => cmdFragment === "" || c.name.startsWith(cmdFragment)));
      setEditSelectedSuggestion(0);
      return;
    }
    setEditCmdSuggestions([]);

    // Check for @ mention fragment
    const mentionMatch = beforeCursor.match(/(?:^|\s)@(.+)$/);
    const atMatch = beforeCursor.match(/(?:^|\s)@$/);
    const mentionFragment = mentionMatch ? mentionMatch[1].toLowerCase() : atMatch ? "" : null;
    if (mentionFragment !== null) {
      setEditTagSuggestions([]);
      setEditMentionSuggestions(filterMentionSuggestions(allTodos, mentionFragment, todo.id));
      setEditSelectedSuggestion(0);
      return;
    }
    setEditMentionSuggestions([]);

    // Check for tag fragment
    if (allTags.length === 0) { setEditTagSuggestions([]); return; }
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

  const applyEditCmdSuggestion = (cmdName: string) => {
    const el = inputRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart ?? editText.length;
    const beforeCursor = editText.slice(0, cursorPos);
    const afterCursor = editText.slice(cursorPos);
    const slashIdx = beforeCursor.lastIndexOf("/");
    if (slashIdx === -1) return;
    const newText = beforeCursor.slice(0, slashIdx) + "/" + cmdName + " " + afterCursor;
    setEditText(newText);
    setEditCmdSuggestions([]);
    setTimeout(() => {
      el.focus();
      const newPos = slashIdx + 1 + cmdName.length + 1;
      el.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const applyEditMentionSuggestion = (refTodo: Todo) => {
    const el = inputRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart ?? editText.length;
    const beforeCursor = editText.slice(0, cursorPos);
    const afterCursor = editText.slice(cursorPos);
    const atIdx = beforeCursor.lastIndexOf("@");
    if (atIdx === -1) return;
    const displayTitle = stripCommandsFromText(stripTagsFromText(refTodo.text)).trim();
    const newText = beforeCursor.slice(0, atIdx) + `@[${displayTitle}](${refTodo.id}) ` + afterCursor;
    setEditText(newText);
    setEditMentionSuggestions([]);
    setTimeout(() => {
      el.focus();
      const newPos = atIdx + `@[${displayTitle}](${refTodo.id}) `.length;
      el.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle suggestion navigation in edit mode (tags, commands, or mentions)
    const hasEditSuggestions = editTagSuggestions.length > 0 || editCmdSuggestions.length > 0 || editMentionSuggestions.length > 0;
    const editSuggestionCount = editTagSuggestions.length || editCmdSuggestions.length || editMentionSuggestions.length;
    if (hasEditSuggestions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEditSelectedSuggestion((s) => Math.min(s + 1, editSuggestionCount - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEditSelectedSuggestion((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        if (editTagSuggestions.length > 0 && editTagSuggestions[editSelectedSuggestion]) {
          e.preventDefault();
          applyEditSuggestion(editTagSuggestions[editSelectedSuggestion]);
          return;
        }
        if (editCmdSuggestions.length > 0 && editCmdSuggestions[editSelectedSuggestion]) {
          e.preventDefault();
          applyEditCmdSuggestion(editCmdSuggestions[editSelectedSuggestion].name);
          return;
        }
        if (editMentionSuggestions.length > 0 && editMentionSuggestions[editSelectedSuggestion]) {
          e.preventDefault();
          applyEditMentionSuggestion(editMentionSuggestions[editSelectedSuggestion]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditTagSuggestions([]);
        setEditCmdSuggestions([]);
        setEditMentionSuggestions([]);
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
    let displayText = stripCommandsFromText(stripTagsFromText(todo.text));
    // Convert @[title](id) mention references to HTML before markdown parsing,
    // so marked doesn't misinterpret them as markdown links (which breaks if
    // the title contains ] or other special chars).
    displayText = displayText.replace(
      /@\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, title: string) => {
        const truncated = title.length > 50 ? title.slice(0, 47) + "…" : title;
        const escaped = truncated.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        return `<span class="todo-mention" title="${escaped}">@${escaped}</span>`;
      }
    );
    const raw = marked.parseInline(displayText) as string;
    return DOMPurify.sanitize(raw);
  }, [todo.text, commands]);

  const isRunning = todo.run_status === "running";
  const isQueued = todo.run_status === "queued";

  return (
    <>
    <div className={`todo-item status-${todo.status} source-${todo.source}${isRunning ? " todo-running" : ""}${isQueued ? " todo-queued" : ""}${todo.run_status === "error" ? " todo-run-error" : ""}${isFocused ? " todo-focused" : ""}${isPending ? " todo-pending" : ""}${todo.manual ? " todo-manual" : ""}`}>
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
              onChange={(e) => { setEditText(e.target.value); computeEditSuggestions(e.target.value); }}
              onBlur={() => { if (editTagSuggestions.length === 0 && editCmdSuggestions.length === 0 && editMentionSuggestions.length === 0) saveEdit(); }}
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
            {editCmdSuggestions.length > 0 && (
              <div className="cmd-suggestions">
                {editCmdSuggestions.map((cmd, i) => (
                  <button
                    key={cmd.name}
                    className={`cmd-suggestion-item${i === editSelectedSuggestion ? " selected" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); applyEditCmdSuggestion(cmd.name); }}
                  >
                    <span className="cmd-suggestion-name">/{cmd.name}</span>
                    <span className={`cmd-suggestion-type cmd-type-${cmd.type}`}>{cmd.type}</span>
                    <span className="cmd-suggestion-desc">{cmd.description}</span>
                  </button>
                ))}
              </div>
            )}
            {editMentionSuggestions.length > 0 && (
              <div className="mention-suggestions">
                {editMentionSuggestions.map((t, i) => (
                  <button
                    key={t.id}
                    className={`mention-suggestion-item${i === editSelectedSuggestion ? " selected" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); applyEditMentionSuggestion(t); }}
                  >
                    <span className="mention-suggestion-title">{stripCommandsFromText(stripTagsFromText(t.text)).trim()}</span>
                    <span className="mention-suggestion-status">{t.run_status ?? t.status}</span>
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
        {todo.manual && <span className="manual-badge" title="Manual task — for human execution, cannot be run by Claude">manual</span>}
        {todo.is_command && <span className="command-badge" title="Skill/command execution">cmd</span>}
        {todo.plan_only && <span className="plan-only-badge" title={todo.plan_file ? `Plan file: ${todo.plan_file}` : "Plan only — agent will plan but not implement"}>{todo.plan_file ? "plan ✓" : "plan"}</span>}
        {todo.user_ordered && <span className="pinned-badge" title="Pinned order — you manually reordered this item">📌</span>}
        {isRunning && <span className="run-spinner" title={todo.plan_only ? "Claude is planning this..." : "Claude is working on this..."}>⟳</span>}
        {isQueued && <span className="queued-badge" title="Queued — waiting for current task to finish">queued</span>}
      </div>
      <div className="todo-meta">
        {todo.images && todo.images.length > 0 && (
          <button
            className={`badge badge-images${showImages ? " badge-images-active" : ""}`}
            title={`${todo.images.length} image${todo.images.length > 1 ? "s" : ""} attached — click to ${showImages ? "hide" : "show"}`}
            onClick={(e) => { e.stopPropagation(); setShowImages((v) => !v); }}
          >
            🖼 {todo.images.length}
          </button>
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
              addOptimisticOverride?.(todo.id, { is_read: newVal });
              onOptimisticUpdate((todos) =>
                todos.map((t) => t.id === todo.id ? { ...t, is_read: newVal } : t)
              );
              try {
                await api.updateTodo(todo.id, { is_read: newVal });
                removeOptimisticOverride?.(todo.id);
                onRefresh();
              } catch {
                removeOptimisticOverride?.(todo.id);
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
        {todo.red_flags && todo.red_flags.length > 0 && (() => {
          const unresolved = todo.red_flags.filter((f) => !f.resolved).length;
          const unresolvedAi = todo.red_flags.filter((f) => !f.resolved && f.source === "ai").length;
          const unresolvedPattern = todo.red_flags.filter((f) => !f.resolved && f.source !== "ai").length;
          const allResolved = unresolved === 0;
          const parts: string[] = [];
          if (unresolvedPattern > 0) parts.push(`${unresolvedPattern} red flag${unresolvedPattern > 1 ? "s" : ""}`);
          if (unresolvedAi > 0) parts.push(`${unresolvedAi} AI flag${unresolvedAi > 1 ? "s" : ""}`);
          return (
            <span
              className={`badge ${allResolved ? "badge-green-flags" : unresolvedAi > 0 && unresolvedPattern === 0 ? "badge-ai-flags" : "badge-red-flags"}`}
              title={todo.red_flags.map((f) => `${f.resolved ? "✓ " : ""}${f.source === "ai" ? "🤖 " : ""}${f.label}`).join(", ")}
              onClick={(e) => { e.stopPropagation(); setShowOutput(true); }}
            >
              {allResolved
                ? `${todo.red_flags.length} resolved`
                : parts.join(", ")}
            </span>
          );
        })()}
        {todo.run_status === "error" && <span className="badge-run-error" title="Run failed">err</span>}
        {!todo.manual && <TodoRunControls todo={todo} onRefresh={onRefresh} addToast={addToast} projectBusy={projectBusy} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={disabled} />}
        {todo.user_ordered && (
          <button className="btn-icon btn-unpin" onClick={unpinOrder} title="Unpin order — let the system reorder this item">📌</button>
        )}
        <button className="btn-icon btn-delete" onClick={remove} title="Delete">×</button>
      </div>
      {todo.status === "stale" && todo.stale_reason && (
        <span className="stale-reason">{todo.stale_reason}</span>
      )}
    </div>
    {(showOutput || showImages) && todo.images && todo.images.length > 0 && (() => {
      const creationImages = todo.images.filter((img) => img.source === "creation");
      const followupImages = todo.images.filter((img) => img.source === "followup");
      const renderThumb = (img: { filename: string; source: string }, idx: number, label: string) => (
        <a key={img.filename} href={api.imageUrl(img.filename)} target="_blank" rel="noopener noreferrer" className="todo-image-thumb">
          <img src={api.imageUrl(img.filename)} alt={`${label} ${idx + 1}`} />
        </a>
      );
      return (
        <div className="todo-images-grouped">
          {creationImages.length > 0 && (
            <div className="todo-images-group">
              {followupImages.length > 0 && <span className="todo-images-group-label">Attached</span>}
              <div className="todo-images">
                {creationImages.map((img, idx) => renderThumb(img, idx, "Attachment"))}
              </div>
            </div>
          )}
          {followupImages.length > 0 && (
            <div className="todo-images-group">
              <span className="todo-images-group-label">Follow-up</span>
              <div className="todo-images">
                {followupImages.map((img, idx) => renderThumb(img, idx, "Follow-up"))}
              </div>
            </div>
          )}
        </div>
      );
    })()}
    {showOutput && todo.original_text && (
      <div className="todo-original-text">
        <span className="todo-original-label">Original:</span> {todo.original_text}
      </div>
    )}
    {showOutput && todo.plan_file && (
      <div className="todo-plan-file">
        <span className="todo-plan-file-label">Plan:</span> <span className="todo-plan-file-path">{todo.plan_file}</span>
      </div>
    )}
    {showOutput && todo.session_id && (
      <div className="todo-session-info">
        <span className="todo-session-label">Session:</span>{" "}
        <span
          className="todo-session-id clickable"
          onClick={() => {
            navigator.clipboard.writeText(todo.session_id!);
            addToast("Session ID copied", "info");
          }}
          title="Click to copy session ID"
        >{todo.session_id}</span>
        {sourcePath && (
          <button
            className="btn-cli-resume"
            onClick={() => {
              const cmd = `cd ${sourcePath} && claude --resume ${todo.session_id}`;
              navigator.clipboard.writeText(cmd);
              addToast("CLI resume command copied to clipboard", "success");
            }}
            title={`Resume in CLI — copies: cd ${sourcePath} && claude --resume ${todo.session_id}`}
          >Resume in CLI</button>
        )}
      </div>
    )}
    <TodoOutput todo={todo} showOutput={showOutput} onRefresh={onRefresh} addToast={addToast} disabled={disabled} allCommands={allCommands} />
    </>
  );
}
