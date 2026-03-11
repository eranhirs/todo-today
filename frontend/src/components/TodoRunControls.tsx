import type { Todo } from "../types";
import { api } from "../api";

interface Props {
  todo: Todo;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  projectBusy?: boolean;
}

export function TodoRunControls({ todo, onRefresh, addToast, projectBusy = false }: Props) {
  const isRunning = todo.run_status === "running";
  const isQueued = todo.run_status === "queued";

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

  if (isRunning) {
    return (
      <button
        className="btn-icon btn-stop"
        onClick={stopRun}
        title="Pause — interrupt and continue via follow-up"
      >⏸</button>
    );
  }

  if (isQueued) {
    return (
      <button
        className="btn-icon btn-dequeue"
        onClick={dequeue}
        title="Remove from queue"
      >✗</button>
    );
  }

  return (
    <button
      className="btn-icon btn-run"
      onClick={runWithClaude}
      title={projectBusy ? "Will be queued — another task is running" : "Run with Claude"}
    >▶</button>
  );
}
