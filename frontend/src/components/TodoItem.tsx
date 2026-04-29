import { useState, useRef, useEffect, useMemo } from "react";
import { isUnread, type AnalysisEntry, type Todo, type TodoStatus } from "../types";
import { api } from "../api";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { TodoRunControls } from "./TodoRunControls";
import { TodoOutput } from "./TodoOutput";
import { parseTags, stripTagsFromText, stripPriorityFromText, PRIORITY_INFO } from "../utils/tags";
import { type CommandInfo, stripCommandsFromText } from "../utils/commands";
import { filterMentionSuggestions, filterParentSuggestions } from "../utils/todoSearch";
import { formatTime, formatDate, timeAgo } from "../utils/formatting";
import { useAppContext } from "../contexts/AppContext";
import { PixelDino } from "./PixelDino";
import { EntryDetail } from "./UpdateHistory";

function scrollToTodo(todoId: string): boolean {
  const el = document.querySelector(`[data-todo-id="${todoId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Re-trigger animation if class is already present (e.g. rapid repeat clicks)
    el.classList.remove("todo-highlight-flash");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("todo-highlight-flash");
    setTimeout(() => el.classList.remove("todo-highlight-flash"), 2000);
    return true;
  }
  return false;
}

function truncateText(text: string, max: number): string {
  const clean = stripCommandsFromText(stripPriorityFromText(stripTagsFromText(text))).trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

interface Props {
  todo: Todo;
  allTags?: string[];
  allTodos?: Todo[];
  allCommands?: CommandInfo[];
  isFocused?: boolean;
  triggerEdit?: boolean;
  projectBusy?: boolean;
  atRunQuotaLimit?: boolean;
  quotaCountdown?: string;
  disabled?: boolean;
  sourcePath?: string;
  onOutputOpen?: (todoId: string) => void;
  onNavigateToTodo?: (todoId: string, projectId: string) => void;
  runModel?: string;
  sessionAutopilot?: Record<string, number>;
  parentTodo?: Todo | null;
  referencedBy?: Todo[];
  analysisHistory?: AnalysisEntry[];
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


export function TodoItem({ todo, allTags = [], allTodos = [], allCommands, isFocused = false, triggerEdit, projectBusy = false, atRunQuotaLimit = false, quotaCountdown = "", disabled = false, sourcePath = "", onOutputOpen, onNavigateToTodo, runModel = "opus", sessionAutopilot = {}, parentTodo = null, referencedBy = [], analysisHistory = [] }: Props) {
  const { addToast, onRefresh, onOptimisticUpdate, optimistic } = useAppContext();
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
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [parentInputText, setParentInputText] = useState("");
  const [parentInputFocused, setParentInputFocused] = useState(false);
  const [parentSelectedIdx, setParentSelectedIdx] = useState(0);
  const parentInputRef = useRef<HTMLInputElement>(null);

  const isActive = !["completed", "rejected", "stale"].includes(todo.status);

  // Navigate to a todo: scroll if visible, otherwise switch project
  const goToTodo = (targetId: string, targetProjectId: string) => {
    if (!scrollToTodo(targetId) && onNavigateToTodo) {
      onNavigateToTodo(targetId, targetProjectId);
    }
  };

  // Manual parent_todo_id wins over session-based inference, so a todo with
  // a manual parent set elsewhere is not counted as a session-based child here.
  const childTodos = useMemo(() => {
    if (!showOutput || allTodos.length === 0) return [];
    return allTodos.filter(t => {
      if (t.id === todo.id) return false;
      if (t.parent_todo_id) return t.parent_todo_id === todo.id;
      return !!(todo.session_id && t.source_session_id === todo.session_id);
    });
  }, [showOutput, todo.session_id, todo.id, allTodos]);

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

  const isExpandable = true;

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
          optimistic.addOptimisticOverride(todo.id, { is_read: true });
          onOptimisticUpdate((todos) =>
            todos.map((t) => t.id === todo.id ? { ...t, is_read: true } : t)
          );
          try {
            await api.updateTodo(todo.id, { is_read: true });
            optimistic.removeOptimisticOverride(todo.id);
            onRefresh();
          } catch {
            optimistic.removeOptimisticOverride(todo.id);
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
    optimistic.addOptimisticOverride(todo.id, override);
    onOptimisticUpdate((todos) =>
      todos.map((t) => t.id === todo.id ? { ...t, ...override } : t)
    );
    try {
      await api.updateTodo(todo.id, { status: newStatus });
      optimistic.removeOptimisticOverride(todo.id);
      onRefresh();
    } catch {
      optimistic.removeOptimisticOverride(todo.id);
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
    optimistic.addPendingDelete(snapshot.id);
    onOptimisticUpdate((todos) => todos.filter((t) => t.id !== todo.id));

    let undone = false;
    const UNDO_DELAY = 5_000;

    const doDelete = async () => {
      if (undone) return;
      optimistic.removePendingDelete(snapshot.id);
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
        optimistic.removePendingDelete(snapshot.id);
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
    optimistic.addOptimisticOverride(todo.id, { user_ordered: false });
    onOptimisticUpdate((todos) =>
      todos.map((t) => t.id === todo.id ? { ...t, user_ordered: false } : t)
    );
    try {
      await api.updateTodo(todo.id, { user_ordered: false });
      optimistic.removeOptimisticOverride(todo.id);
      onRefresh();
    } catch {
      optimistic.removeOptimisticOverride(todo.id);
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
      optimistic.addOptimisticOverride(todo.id, { text: trimmed });
      onOptimisticUpdate((todos) =>
        todos.map((t) => t.id === todo.id ? { ...t, text: trimmed } : t)
      );
      try {
        await api.updateTodo(todo.id, { text: trimmed, source: "user" });
        optimistic.removeOptimisticOverride(todo.id);
        onRefresh();
      } catch {
        optimistic.removeOptimisticOverride(todo.id);
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
    let displayText = stripCommandsFromText(stripPriorityFromText(stripTagsFromText(todo.text)));
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

  // Recursively render a child todo tree with indentation
  const renderChildTree = (children: Todo[], depth: number = 0, visited: Set<string> = new Set()): React.ReactNode => {
    if (children.length === 0 || depth > 10) return null;
    return (
      <ul className="todo-children-list" style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
        {children.map(child => {
          const grandchildren = allTodos.filter(t => {
            if (t.id === child.id) return false;
            if (t.parent_todo_id) return t.parent_todo_id === child.id && !visited.has(`id:${child.id}`);
            return !!(child.session_id && t.source_session_id === child.session_id && !visited.has(child.session_id));
          });
          const nextVisited = new Set([...visited, `id:${child.id}`]);
          if (child.session_id) nextVisited.add(child.session_id);
          return (
            <li key={child.id} className="todo-child-item">
              <span
                className={`todo-child-status status-${child.status}`}
              >{STATUS_OPTIONS.find(s => s.value === child.status)?.icon ?? "·"}</span>
              <span
                className="todo-child-link clickable"
                onClick={() => goToTodo(child.id, child.project_id)}
                title="Click to jump to this todo"
              >{truncateText(child.text, 120)}</span>
              <span className={`todo-child-status-label status-${child.status}`}>
                {child.status.replace("_", " ")}
              </span>
              {grandchildren.length > 0 && renderChildTree(grandchildren, depth + 1, nextVisited)}
            </li>
          );
        })}
      </ul>
    );
  };

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
        {todo.priority !== null && PRIORITY_INFO[todo.priority] && (
          <span
            className={`priority-badge priority-${todo.priority}`}
            title={`Priority: ${PRIORITY_INFO[todo.priority].label} — click to remove`}
            style={{ borderColor: PRIORITY_INFO[todo.priority].color, color: PRIORITY_INFO[todo.priority].color, cursor: "pointer" }}
            onClick={async (e) => {
              e.stopPropagation();
              const newText = stripPriorityFromText(todo.text);
              if (newText === todo.text) return;
              const prevText = todo.text;
              optimistic.addOptimisticOverride(todo.id, { text: newText, priority: null });
              onOptimisticUpdate((todos) =>
                todos.map((t) => t.id === todo.id ? { ...t, text: newText, priority: null } : t)
              );
              try {
                await api.updateTodo(todo.id, { text: newText, source: "user" });
                optimistic.removeOptimisticOverride(todo.id);
                onRefresh();
              } catch {
                optimistic.removeOptimisticOverride(todo.id);
                onOptimisticUpdate((todos) =>
                  todos.map((t) => t.id === todo.id ? { ...t, text: prevText, priority: todo.priority } : t)
                );
                addToast("Failed to remove priority", "error");
              }
            }}
          >
            {PRIORITY_INFO[todo.priority].short}
          </span>
        )}
        {isPending && <span className="pending-badge" title="Not sent — added while offline">not sent</span>}
        {todo.manual && <span className="manual-badge" title="Manual task — for human execution, cannot be run by Claude">manual</span>}
        {todo.is_command && <span className="command-badge" title="Skill/command execution">cmd</span>}
        {todo.plan_only && <span className="plan-only-badge" title={todo.plan_file ? `Plan file: ${todo.plan_file}` : "Plan only — agent will plan but not implement"}>{todo.plan_file ? "plan ✓" : "plan"}</span>}
        {parentTodo && (
          <span
            className="parent-badge"
            title={`Child of: ${truncateText(parentTodo.text, 80)}`}
            onClick={(e) => { e.stopPropagation(); goToTodo(parentTodo.id, parentTodo.project_id); }}
          >↑ parent</span>
        )}
        {referencedBy.length > 0 && (
          <span
            className="referenced-by-badge"
            title={`Referenced by ${referencedBy.length} todo${referencedBy.length > 1 ? "s" : ""} — click to expand`}
            onClick={(e) => {
              e.stopPropagation();
              if (!showOutput) {
                setShowOutput(true);
                onOutputOpen?.(todo.id);
              }
            }}
          >↗ ref {referencedBy.length}</span>
        )}
        {todo.user_ordered && <span className="pinned-badge" title="Pinned order — you manually reordered this item">📌</span>}
        {isRunning && <PixelDino title={todo.plan_only ? "Claude is planning this..." : "Claude is working on this..."} />}
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
              optimistic.addOptimisticOverride(todo.id, { is_read: newVal });
              onOptimisticUpdate((todos) =>
                todos.map((t) => t.id === todo.id ? { ...t, is_read: newVal } : t)
              );
              try {
                await api.updateTodo(todo.id, { is_read: newVal });
                optimistic.removeOptimisticOverride(todo.id);
                onRefresh();
              } catch {
                optimistic.removeOptimisticOverride(todo.id);
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
        {isActive && !todo.manual && (
          <button
            className={`badge badge-session-keep-alive${todo.autopilot ? " active" : ""}`}
            title={todo.autopilot
              ? "Autopilot ON — analyzer-suggested follow-ups are auto-sent to keep the session alive. Click to disable."
              : "Autopilot OFF — analyzer suggestions show up as a banner but aren't sent automatically. Click to enable."
            }
            onClick={async (e) => {
              e.stopPropagation();
              const newVal = !todo.autopilot;
              optimistic.addOptimisticOverride(todo.id, { autopilot: newVal });
              onOptimisticUpdate((todos) =>
                todos.map((t) => t.id === todo.id ? { ...t, autopilot: newVal } : t)
              );
              try {
                await api.setAutopilot(todo.id, newVal);
                optimistic.removeOptimisticOverride(todo.id);
                onRefresh();
                addToast(newVal ? "Autopilot enabled — session will be kept alive" : "Autopilot disabled", newVal ? "success" : "info");
              } catch {
                optimistic.removeOptimisticOverride(todo.id);
                onOptimisticUpdate((todos) =>
                  todos.map((t) => t.id === todo.id ? { ...t, autopilot: !newVal } : t)
                );
                addToast("Failed to toggle autopilot", "error");
              }
            }}
          >🚁{todo.suggested_followup && !todo.pending_followup && <span className="badge-suggestion-dot" title="Analyzer has a follow-up suggestion">•</span>}</button>
        )}
        {todo.source_session_id && sessionAutopilot[todo.source_session_id] > 0 && !isRunning && (
          <span className="badge badge-session-autopilot" title={`Part of session autopilot chain (${sessionAutopilot[todo.source_session_id]} remaining)`}>🔗</span>
        )}
        {todo.run_after && new Date(todo.run_after) > new Date() && (
          <span className="badge badge-scheduled" title={`Scheduled: runs after ${new Date(todo.run_after).toLocaleString()}`}>🕐</span>
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
        {isActive && !todo.manual && <TodoRunControls todo={todo} onRefresh={onRefresh} addToast={addToast} projectBusy={projectBusy} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={disabled} runModel={runModel} />}
        {!isRunning && !isQueued && (todo.status === "next" || todo.status === "completed") && !todo.manual && (() => {
          const sessionKey = todo.session_id || todo.source_session_id;
          const activeQuota = sessionKey ? (sessionAutopilot[sessionKey] ?? 0) : (todo.pending_session_autopilot ?? 0);
          return (
            <select
              className={`session-autopilot-select${activeQuota > 0 ? " session-autopilot-active" : ""}`}
              value={String(activeQuota)}
              title={activeQuota > 0 ? `Session autopilot: ${activeQuota} remaining — descendants of this session will auto-run` : "Session autopilot — auto-run descendants of this session"}
              onChange={async (e) => {
                const quota = Number(e.target.value);
                try {
                  await api.setSessionAutopilot(todo.id, quota);
                  onRefresh();
                  if (quota > 0) {
                    addToast(`Session autopilot enabled (${quota} runs)`, "success");
                  } else {
                    addToast("Session autopilot disabled", "info");
                  }
                } catch {
                  addToast("Failed to set session autopilot", "error");
                }
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <option value="0">--</option>
              <option value="1">1</option>
              <option value="3">3</option>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
            </select>
          );
        })()}
        {!isRunning && !isQueued && todo.status === "next" && !todo.manual && (() => {
          const hasSchedule = !!todo.run_after;
          const isPast = hasSchedule && new Date(todo.run_after!) <= new Date();
          const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const tzAbbr = new Date().toLocaleTimeString([], { timeZoneName: "short" }).split(" ").pop() ?? localTz;
          const pad = (n: number) => String(n).padStart(2, "0");
          const fmtSchedule = (d: Date) =>
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
          const toInputVal = (d: Date) =>
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          return (
            <span className={`todo-schedule-control${hasSchedule ? " has-schedule" : ""}`}>
              {hasSchedule ? (
                <>
                  <input
                    type="datetime-local"
                    className="todo-schedule-time"
                    value={toInputVal(new Date(todo.run_after!))}
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      const local = new Date(e.target.value);
                      const runAfter = local.toISOString().replace(/\.\d{3}Z$/, "Z");
                      onOptimisticUpdate((todos) =>
                        todos.map((t) => t.id === todo.id ? { ...t, run_after: runAfter } : t)
                      );
                      try {
                        await api.scheduleTodo(todo.id, runAfter);
                        onRefresh();
                      } catch {
                        addToast("Failed to update schedule", "error");
                        onRefresh();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span
                    className="schedule-display-overlay"
                    title={`${fmtSchedule(new Date(todo.run_after!))} ${tzAbbr} (${localTz})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const input = e.currentTarget.parentElement?.querySelector<HTMLInputElement>(".todo-schedule-time");
                      if (input) { try { input.showPicker(); } catch { input.focus(); } }
                    }}
                  >
                    {fmtSchedule(new Date(todo.run_after!))}
                  </span>
                  <span className="schedule-tz-label" title={localTz}>{tzAbbr}</span>
                  {isPast && <span className="schedule-ready-badge" title="Schedule time has passed — ready to run">ready</span>}
                  <button
                    className="btn-icon btn-schedule-clear"
                    title="Clear schedule"
                    onClick={async (e) => {
                      e.stopPropagation();
                      onOptimisticUpdate((todos) =>
                        todos.map((t) => t.id === todo.id ? { ...t, run_after: null } : t)
                      );
                      try {
                        await api.scheduleTodo(todo.id, null);
                        onRefresh();
                        addToast("Schedule cleared", "info");
                      } catch {
                        addToast("Failed to clear schedule", "error");
                        onRefresh();
                      }
                    }}
                  >x</button>
                </>
              ) : (
                <button
                  className="btn-icon btn-schedule"
                  title={`Schedule — set a time for autopilot to run this todo (${tzAbbr})`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    // Default to next usage window reset time, fallback to next 2AM UTC
                    let scheduleTime: Date;
                    try {
                      const usage = await api.getClaudeUsage();
                      const resetAt = usage.five_hour?.resets_at;
                      if (resetAt) {
                        const resetDate = new Date(resetAt);
                        if (resetDate > new Date()) {
                          scheduleTime = new Date(resetDate.getTime() + 60_000); // 1 min after reset
                        } else {
                          scheduleTime = new Date();
                          scheduleTime.setUTCHours(2, 0, 0, 0);
                          if (scheduleTime <= new Date()) scheduleTime.setUTCDate(scheduleTime.getUTCDate() + 1);
                        }
                      } else {
                        scheduleTime = new Date();
                        scheduleTime.setUTCHours(2, 0, 0, 0);
                        if (scheduleTime <= new Date()) scheduleTime.setUTCDate(scheduleTime.getUTCDate() + 1);
                      }
                    } catch {
                      scheduleTime = new Date();
                      scheduleTime.setUTCHours(2, 0, 0, 0);
                      if (scheduleTime <= new Date()) scheduleTime.setUTCDate(scheduleTime.getUTCDate() + 1);
                    }
                    const runAfter = scheduleTime.toISOString().replace(/\.\d{3}Z$/, "Z");
                    onOptimisticUpdate((todos) =>
                      todos.map((t) => t.id === todo.id ? { ...t, run_after: runAfter } : t)
                    );
                    try {
                      await api.scheduleTodo(todo.id, runAfter);
                      onRefresh();
                      addToast(`Scheduled for ${fmtSchedule(scheduleTime)} ${tzAbbr}`, "success");
                    } catch {
                      addToast("Failed to schedule todo", "error");
                      onRefresh();
                    }
                  }}
                >🕐</button>
              )}
            </span>
          );
        })()}
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
    {showOutput && (() => {
      const parentSuggestions = parentInputFocused
        ? filterParentSuggestions(allTodos, parentInputText, todo.id, todo.project_id)
        : [];
      const setParent = async (newParentId: string) => {
        const current = todo.parent_todo_id || "";
        if (newParentId === current) return;
        const prev = todo.parent_todo_id;
        optimistic.addOptimisticOverride(todo.id, { parent_todo_id: newParentId || null });
        onOptimisticUpdate((todos) =>
          todos.map((t) => t.id === todo.id ? { ...t, parent_todo_id: newParentId || null } : t)
        );
        try {
          await api.updateTodo(todo.id, { parent_todo_id: newParentId });
          optimistic.removeOptimisticOverride(todo.id);
          onRefresh();
          addToast(newParentId ? "Parent set" : "Manual parent cleared", "info");
        } catch {
          optimistic.removeOptimisticOverride(todo.id);
          onOptimisticUpdate((todos) =>
            todos.map((t) => t.id === todo.id ? { ...t, parent_todo_id: prev } : t)
          );
          addToast("Failed to update parent", "error");
        }
      };
      const pickSuggestion = (picked: Todo) => {
        setParentInputText("");
        setParentSelectedIdx(0);
        setParentInputFocused(false);
        parentInputRef.current?.blur();
        setParent(picked.id);
      };
      return (
        <div className="todo-parent-info">
          <span className="todo-parent-label">Parent:</span>{" "}
          {parentTodo ? (
            <>
              <span
                className="todo-parent-link clickable"
                onClick={() => goToTodo(parentTodo.id, parentTodo.project_id)}
                title="Click to jump to parent todo"
              >{truncateText(parentTodo.text, 100)}</span>
              <span className={`todo-parent-status status-${parentTodo.status}`}>
                {parentTodo.status.replace("_", " ")}
              </span>
              {todo.parent_todo_id && (
                <span className="todo-parent-manual-tag" title="Parent was set manually">manual</span>
              )}
            </>
          ) : (
            <span className="todo-parent-empty">(none)</span>
          )}
          <div className="todo-parent-input-wrapper">
            <input
              ref={parentInputRef}
              type="text"
              className="todo-parent-input"
              placeholder={parentTodo ? "Change parent…" : "Set parent…"}
              value={parentInputText}
              disabled={disabled}
              onFocus={() => { setParentInputFocused(true); setParentSelectedIdx(0); }}
              // Delay blur so clicks on suggestions can register first.
              onBlur={() => { setTimeout(() => setParentInputFocused(false), 120); }}
              onChange={(e) => { setParentInputText(e.target.value); setParentSelectedIdx(0); }}
              onKeyDown={(e) => {
                if (!parentInputFocused) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setParentSelectedIdx((i) => Math.min(i + 1, Math.max(0, parentSuggestions.length - 1)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setParentSelectedIdx((i) => Math.max(i - 1, 0));
                } else if ((e.key === "Enter" || e.key === "Tab") && parentSuggestions[parentSelectedIdx]) {
                  e.preventDefault();
                  pickSuggestion(parentSuggestions[parentSelectedIdx]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setParentInputText("");
                  setParentInputFocused(false);
                  parentInputRef.current?.blur();
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {parentInputFocused && parentSuggestions.length > 0 && (
              <div className="mention-suggestions todo-parent-suggestions">
                {parentSuggestions.map((s, i) => (
                  <button
                    key={s.id}
                    className={`mention-suggestion-item${i === parentSelectedIdx ? " selected" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                  >
                    <span className="mention-suggestion-title">{truncateText(s.text, 80)}</span>
                    <span className="mention-suggestion-status">{s.run_status ?? s.status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {todo.parent_todo_id && (
            <button
              className="btn-icon btn-parent-clear"
              title="Clear manual parent"
              onClick={(e) => { e.stopPropagation(); setParent(""); }}
            >×</button>
          )}
        </div>
      );
    })()}
    {showOutput && childTodos.length > 0 && (() => {
      const initialVisited = new Set<string>([`id:${todo.id}`]);
      if (todo.session_id) initialVisited.add(todo.session_id);
      return (
        <div className="todo-children-info">
          <span className="todo-children-label">Children ({childTodos.length}):</span>
          {renderChildTree(childTodos, 0, initialVisited)}
        </div>
      );
    })()}
    {showOutput && referencedBy.length > 0 && (
      <div className="todo-referenced-by-info">
        <span className="todo-referenced-by-label">Referenced by ({referencedBy.length}):</span>
        <ul className="todo-referenced-by-list">
          {referencedBy.map((ref) => (
            <li key={ref.id} className="todo-referenced-by-item">
              <span className={`todo-child-status status-${ref.status}`}>
                {STATUS_OPTIONS.find(s => s.value === ref.status)?.icon ?? "·"}
              </span>
              <span
                className="todo-child-link clickable"
                onClick={() => goToTodo(ref.id, ref.project_id)}
                title="Click to jump to this todo"
              >{truncateText(ref.text, 120)}</span>
              <span className={`todo-child-status-label status-${ref.status}`}>
                {ref.status.replace("_", " ")}
              </span>
            </li>
          ))}
        </ul>
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
        {sourcePath && (<>
          <button
            className="btn-cli-resume"
            onClick={() => {
              const cmd = `cd ${sourcePath} && claude --resume ${todo.session_id}`;
              navigator.clipboard.writeText(cmd);
              addToast("CLI resume command copied to clipboard", "success");
            }}
            title={`Resume in CLI — copies: cd ${sourcePath} && claude --resume ${todo.session_id}`}
          >Resume in CLI</button>
          <button
            className="btn-cli-resume"
            onClick={() => {
              const encoded = sourcePath.replace(/\//g, "-").replace(/\./g, "-");
              const jsonlPath = `~/.claude/projects/${encoded}/${todo.session_id}.jsonl`;
              navigator.clipboard.writeText(jsonlPath);
              addToast("JSONL path copied to clipboard", "info");
            }}
            title="Copy session JSONL file path"
          >JSONL Path</button>
        </>)}
        {todo.run_cost_usd != null && todo.run_cost_usd > 0 && (() => {
          const contextTokens = todo.run_context_tokens ?? 0;
          const tokenLabel = contextTokens >= 1000
            ? `${Math.round(contextTokens / 1000)}k`
            : `${contextTokens}`;
          return (
            <span
              className="todo-run-cost"
              title={[
                `Input: ${((todo.run_input_tokens ?? 0) / 1000).toFixed(1)}k tokens`,
                `Output: ${((todo.run_output_tokens ?? 0) / 1000).toFixed(1)}k tokens`,
                todo.run_cache_read_tokens ? `Cache read: ${((todo.run_cache_read_tokens) / 1000).toFixed(1)}k tokens` : "",
                todo.run_duration_ms ? `Duration: ${(todo.run_duration_ms / 1000).toFixed(0)}s` : "",
              ].filter(Boolean).join("\n")}
            >
              ${todo.run_cost_usd < 0.01 ? todo.run_cost_usd.toFixed(3) : todo.run_cost_usd.toFixed(2)}
              {contextTokens > 0 && <span className="todo-run-tokens"> · {tokenLabel} ctx</span>}
            </span>
          );
        })()}
      </div>
    )}
    {showOutput && todo.completed_by_run && (() => {
      const analysisEntry = analysisHistory.find(e => e.completed_todo_ids?.includes(todo.id));
      if (!analysisEntry) return null;
      return (
        <div className="todo-analysis-section">
          <button
            className="btn-link todo-analysis-toggle"
            onClick={() => setShowAnalysis(!showAnalysis)}
          >
            {showAnalysis ? "▾" : "▸"} View Analysis
            <span className="todo-analysis-meta">
              {new Date(analysisEntry.timestamp).toLocaleString()}
              {analysisEntry.trigger && <span className={`history-trigger-badge trigger-${analysisEntry.trigger}`}>{analysisEntry.trigger}</span>}
            </span>
          </button>
          {showAnalysis && <EntryDetail entry={analysisEntry} />}
        </div>
      );
    })()}
    <TodoOutput todo={todo} showOutput={showOutput} disabled={disabled} allCommands={allCommands} />
    </>
  );
}
