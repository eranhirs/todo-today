import type { Todo } from "../types";
import { api } from "../api";

interface Props {
  todo: Todo;
  onRefresh: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function TodoItem({ todo, onRefresh }: Props) {
  const toggle = async () => {
    await api.updateTodo(todo.id, { completed: !todo.completed });
    onRefresh();
  };

  const remove = async () => {
    await api.deleteTodo(todo.id);
    onRefresh();
  };

  return (
    <div className={`todo-item ${todo.completed ? "completed" : ""} source-${todo.source}`}>
      <label className="todo-check">
        <input type="checkbox" checked={todo.completed} onChange={toggle} />
        <span className="todo-text">{todo.text}</span>
      </label>
      <div className="todo-meta">
        <span className="todo-timestamp" title={todo.created_at}>
          {formatDate(todo.created_at)} {formatTime(todo.created_at)}
        </span>
        {todo.completed && todo.completed_at && (
          <span className="todo-timestamp todo-completed-at" title={`Completed: ${todo.completed_at}`}>
            ✓ {formatTime(todo.completed_at)}
          </span>
        )}
        {todo.source === "claude" && <span className="badge badge-claude" title="Added by Claude">🤖</span>}
        <button className="btn-icon btn-delete" onClick={remove} title="Delete">×</button>
      </div>
    </div>
  );
}
