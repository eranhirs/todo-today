import type { Todo } from "../types";
import { api } from "../api";
import { apiErrorMessage } from "../errors";

interface Props {
  todo: Todo;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  projectBusy?: boolean;
  atRunQuotaLimit?: boolean;
  quotaCountdown?: string;
  disabled?: boolean;
}

export function TodoRunControls({ todo, onRefresh, addToast, projectBusy = false, atRunQuotaLimit = false, quotaCountdown = "", disabled = false }: Props) {
  const isRunning = todo.run_status === "running";
  const isQueued = todo.run_status === "queued";

  const runWithClaude = async (planOnly?: boolean) => {
    if (disabled) {
      addToast("You're offline — running tasks isn't available right now", "warning");
      return;
    }
    try {
      const result = await api.runTodo(todo.id, planOnly);
      const label = planOnly ? "planning" : "running";
      if (result.status === "queued") {
        addToast(`Queued "${todo.text}" — will ${planOnly ? "plan" : "run"} when the current task finishes`, "info");
      } else {
        addToast(`Started ${label} "${todo.text}" with Claude`, "info");
      }
      onRefresh();
    } catch (err) {
      addToast(apiErrorMessage(err), "error");
    }
  };

  const dequeue = async () => {
    if (disabled) {
      addToast("You're offline — dequeuing isn't available right now", "warning");
      return;
    }
    try {
      await api.dequeueTodo(todo.id);
      addToast(`Removed "${todo.text}" from queue`, "info");
      onRefresh();
    } catch (err) {
      addToast(apiErrorMessage(err), "error");
    }
  };

  const stopRun = async () => {
    if (disabled) {
      addToast("You're offline — stopping tasks isn't available right now", "warning");
      return;
    }
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

  // Disable run buttons for fresh (never-run) todos when at daily run limit
  const quotaBlocked = atRunQuotaLimit && !todo.run_started_at;
  const quotaTitle = quotaBlocked
    ? `Daily run limit reached${quotaCountdown ? ` — next slot in ${quotaCountdown}` : ""}`
    : "";

  return (
    <>
      <button
        className="btn-icon btn-plan"
        onClick={() => runWithClaude(true)}
        disabled={quotaBlocked}
        title={disabled ? "Server offline" : quotaBlocked ? quotaTitle : projectBusy ? "Plan with Claude (queued — another task is running)" : "Plan with Claude — analyze and outline an approach without making code changes"}
      >📋</button>
      <button
        className="btn-icon btn-run"
        onClick={() => runWithClaude(false)}
        disabled={quotaBlocked}
        title={disabled ? "Server offline" : quotaBlocked ? quotaTitle : projectBusy ? "Run with Claude (queued — another task is running)" : "Run with Claude — implement this task, making code changes as needed"}
      >▶</button>
    </>
  );
}
