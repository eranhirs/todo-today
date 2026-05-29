import { EFFORT_LEVELS, type EffortLevel, type Todo } from "../types";
import { api } from "../api";
import { apiErrorMessage } from "../errors";
import { useState } from "react";

interface Props {
  todo: Todo;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  projectBusy?: boolean;
  atRunQuotaLimit?: boolean;
  quotaCountdown?: string;
  disabled?: boolean;
  runModel?: string;
  /** Resolved default effort (per-todo > project > global) — initial value of the picker. */
  runEffort?: string;
}

export function TodoRunControls({ todo, onRefresh, addToast, projectBusy = false, atRunQuotaLimit = false, quotaCountdown = "", disabled = false, runModel = "opus", runEffort = "high" }: Props) {
  const isRunning = todo.run_status === "running";
  const isQueued = todo.run_status === "queued";
  // Per-run effort override picker. The `effortPick` state tracks the user's
  // choice for the next run: an EffortLevel persists it on the todo, "" clears
  // any per-todo override (inherit project/global), null = leave unchanged.
  // The displayed value defaults to the current per-todo override if any,
  // otherwise the resolved (project/global) value.
  const initialEffort = (todo.run_effort ?? runEffort) as string;
  const [effortPick, setEffortPick] = useState<EffortLevel | "" | null>(null);
  // Show "default" when there's no per-todo override yet AND the user hasn't picked
  const displayValue = effortPick !== null ? effortPick : (todo.run_effort ?? "");

  const runWithClaude = async (planOnly?: boolean) => {
    if (disabled) {
      addToast("You're offline — running tasks isn't available right now", "warning");
      return;
    }
    try {
      // Send the picked value when set: a level persists it on the todo, "" clears any per-todo override.
      const effortToSend = effortPick === null ? undefined : effortPick;
      const result = await api.runTodo(todo.id, planOnly, effortToSend);
      const label = planOnly ? "planning" : "running";
      const effortNote = effortPick ? ` at ${effortPick} effort` : "";
      if (result.status === "queued") {
        addToast(`Queued "${todo.text}" — will ${planOnly ? "plan" : "run"}${effortNote} when the current task finishes`, "info");
      } else {
        addToast(`Started ${label} "${todo.text}" with Claude${effortNote}`, "info");
      }
      setEffortPick(null);
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

  const runNow = async () => {
    if (disabled) {
      addToast("You're offline — running tasks isn't available right now", "warning");
      return;
    }
    try {
      await api.runTodoNow(todo.id);
      addToast(`Started "${todo.text}" — running alongside the current task`, "info");
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
      <>
        <button
          className="btn-icon btn-run-now"
          onClick={runNow}
          disabled={disabled}
          title="Run now — start this concurrently with the current task (may conflict on file edits)"
        >⏩</button>
        <button
          className="btn-icon btn-dequeue"
          onClick={dequeue}
          title="Remove from queue"
        >✗</button>
      </>
    );
  }

  // Disable run buttons for fresh (never-run) todos when at daily run limit
  const quotaBlocked = atRunQuotaLimit && !todo.run_started_at;
  const quotaTitle = quotaBlocked
    ? `Daily run limit reached${quotaCountdown ? ` — next slot in ${quotaCountdown}` : ""}`
    : "";

  const effortNote = `, effort ${effortPick ?? initialEffort}${todo.run_effort ? " (todo)" : effortPick ? " (override)" : ""}`;

  return (
    <>
      {quotaBlocked && quotaCountdown && (
        <span className="run-quota-countdown" title={quotaTitle}>⏸ {quotaCountdown}</span>
      )}
      <select
        className={`effort-select${todo.run_effort ? " effort-overridden" : ""}`}
        value={displayValue}
        onChange={async (e) => {
          const val = e.target.value;
          const pick = val === "" ? "" : (val as EffortLevel);
          setEffortPick(pick);
          try {
            if (pick === "") {
              await api.updateTodo(todo.id, { clear_run_effort: true });
            } else {
              await api.updateTodo(todo.id, { run_effort: pick });
            }
            onRefresh();
          } catch (err) {
            addToast(apiErrorMessage(err), "error");
          }
        }}
        disabled={disabled || quotaBlocked}
        title={`Claude --effort for the next run. "default" inherits project/global (${initialEffort}); picking a level persists it on this todo.`}
        onClick={(e) => e.stopPropagation()}
      >
        <option value="">default ({initialEffort})</option>
        {EFFORT_LEVELS.map((lv) => (
          <option key={lv} value={lv}>{lv}</option>
        ))}
      </select>
      <button
        className="btn-icon btn-plan"
        onClick={() => runWithClaude(true)}
        disabled={quotaBlocked}
        title={disabled ? "Server offline" : quotaBlocked ? quotaTitle : projectBusy ? `Plan with Claude [${runModel}${effortNote}] (queued — another task is running)` : `Plan with Claude [${runModel}${effortNote}] — analyze and outline an approach without making code changes`}
      >📋</button>
      <button
        className="btn-icon btn-run"
        onClick={() => runWithClaude(false)}
        disabled={quotaBlocked}
        title={disabled ? "Server offline" : quotaBlocked ? quotaTitle : projectBusy ? `Run with Claude [${runModel}${effortNote}] (queued — another task is running)` : `Run with Claude [${runModel}${effortNote}] — implement this task, making code changes as needed`}
      >▶</button>
    </>
  );
}
