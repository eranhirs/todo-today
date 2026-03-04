import type { Todo } from "../types";
import { api } from "../api";

interface Props {
  todo: Todo;
  onRefresh: () => void;
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
        {todo.source === "claude" && <span className="badge badge-claude" title="Added by Claude">🤖</span>}
        <button className="btn-icon btn-delete" onClick={remove} title="Delete">×</button>
      </div>
    </div>
  );
}
