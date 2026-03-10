import { useState } from "react";
import type { Todo } from "../types";
import { api } from "../api";

interface Props {
  projectId: string;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function AddTodo({ projectId, onRefresh, addToast, onOptimisticUpdate, inputRef }: Props) {
  const [text, setText] = useState("");

  const handleAdd = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Optimistic placeholder
    const tempId = `temp-${Date.now()}`;
    const placeholder: Todo = {
      id: tempId,
      project_id: projectId,
      text: trimmed,
      status: "next",
      source: "user",
      session_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      run_output: null,
      run_status: null,
      run_trigger: null,
    };
    onOptimisticUpdate((todos) => [placeholder, ...todos]);
    setText("");

    try {
      await api.createTodo(projectId, trimmed);
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) => todos.filter((t) => t.id !== tempId));
      setText(trimmed);
      addToast(`Failed to add "${trimmed}"`, "error");
    }
  };

  return (
    <div className="add-todo">
      <input
        placeholder="Add a todo..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        ref={inputRef}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleAdd();
          } else if (e.key === "Enter") {
            handleAdd();
          }
        }}
      />
      <button onClick={handleAdd}>Add</button>
    </div>
  );
}
