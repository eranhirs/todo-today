import { useState, useRef, useEffect } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";

interface Props {
  projectId?: string;
  projects?: Project[];
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function AddTodo({ projectId, projects, onRefresh, addToast, onOptimisticUpdate, inputRef }: Props) {
  const [text, setText] = useState("");
  const [selectedProject, setSelectedProject] = useState(projectId ?? "");
  const localRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? localRef;

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  }, [text, textareaRef]);

  const handleAdd = async () => {
    const trimmed = text.trim();
    const pid = projectId ?? selectedProject;
    if (!trimmed || !pid) {
      if (!pid) addToast("Select a project first", "warning");
      return;
    }

    // Optimistic placeholder
    const tempId = `temp-${Date.now()}`;
    const placeholder: Todo = {
      id: tempId,
      project_id: pid,
      text: trimmed,
      status: "next",
      source: "user",
      emoji: null,
      session_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      run_output: null,
      run_status: null,
      run_trigger: null,
      sort_order: 0,
    };
    onOptimisticUpdate((todos) => [placeholder, ...todos]);
    setText("");

    try {
      await api.createTodo(pid, trimmed);
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) => todos.filter((t) => t.id !== tempId));
      setText(trimmed);
      addToast(`Failed to add "${trimmed}"`, "error");
    }
  };

  const needsProjectSelector = !projectId && projects && projects.length > 0;

  return (
    <div className="add-todo">
      {needsProjectSelector && (
        <select
          className="add-todo-project-select"
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
        >
          <option value="">Project...</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
      <textarea
        placeholder="Add a todo... (Shift+Enter for new line)"
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        ref={textareaRef}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey) {
            // Allow default — inserts newline
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            handleAdd();
          }
        }}
      />
      <button onClick={handleAdd}>Add</button>
    </div>
  );
}
