import { useState, useRef, useEffect } from "react";
import type { Todo, TodoStatus } from "../types";
import { api } from "../api";

interface Props {
  todo: Todo;
  onRefresh: () => void;
}

const STATUS_OPTIONS: { value: TodoStatus; label: string; icon: string }[] = [
  { value: "next", label: "Up Next", icon: "→" },
  { value: "in_progress", label: "In Progress", icon: "●" },
  { value: "completed", label: "Completed", icon: "✓" },
  { value: "consider", label: "Consider", icon: "?" },
  { value: "waiting", label: "Waiting", icon: "⏸" },
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

export function TodoItem({ todo, onRefresh }: Props) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const changeStatus = async (newStatus: TodoStatus) => {
    await api.updateTodo(todo.id, { status: newStatus });
    onRefresh();
  };

  const remove = async () => {
    await api.deleteTodo(todo.id);
    onRefresh();
  };

  const startEdit = () => {
    setEditText(todo.text);
    setEditing(true);
  };

  const saveEdit = async () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== todo.text) {
      await api.updateTodo(todo.id, { text: trimmed, source: "user" });
      onRefresh();
    }
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditText(todo.text);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  };

  return (
    <div className={`todo-item status-${todo.status} source-${todo.source}`}>
      <div className="todo-content">
        <select
          className="status-select"
          value={todo.status}
          onChange={(e) => changeStatus(e.target.value as TodoStatus)}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.icon} {opt.label}
            </option>
          ))}
        </select>
        {editing ? (
          <input
            ref={inputRef}
            className="todo-text-input"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="todo-text" onDoubleClick={startEdit}>{todo.text}</span>
        )}
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
        <button className="btn-icon btn-delete" onClick={remove} title="Delete">×</button>
      </div>
    </div>
  );
}
