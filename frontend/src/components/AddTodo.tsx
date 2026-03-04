import { useState } from "react";
import { api } from "../api";

interface Props {
  projectId: string;
  onRefresh: () => void;
}

export function AddTodo({ projectId, onRefresh }: Props) {
  const [text, setText] = useState("");

  const handleAdd = async () => {
    if (!text.trim()) return;
    await api.createTodo(projectId, text.trim());
    setText("");
    onRefresh();
  };

  return (
    <div className="add-todo">
      <input
        placeholder="Add a todo..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
      />
      <button onClick={handleAdd}>Add</button>
    </div>
  );
}
