import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";
import { getDisplayName } from "../utils/displayNames";

const TOAST_DURATION = 12_000;
const TITLE_FLASH_INTERVAL = 1_000;

/* SVG data-URI icons for browser notifications, one per event type */
const svgIcon = (emoji: string, bg: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" rx="12" fill="${bg}"/>` +
    `<text x="32" y="46" font-size="36" text-anchor="middle">${emoji}</text>` +
    `</svg>`
  )}`;

export const NOTIF_ICONS = {
  todo:           svgIcon("📋", "#3b82f6"),
  approval:       svgIcon("🔑", "#f59e0b"),
  user_input:     svgIcon("💬", "#f59e0b"),
  ended:          svgIcon("✅", "#22c55e"),
  run_success:    svgIcon("✅", "#22c55e"),
  run_error:      svgIcon("❌", "#ef4444"),
} as const;

export type ToastType = "info" | "warning" | "success" | "error";

export interface ToastAction {
  label: string;
  handler: () => void;
}

export interface Toast {
  id: string;
  text: string;
  type: ToastType;
  onUndo?: () => void;
  action?: ToastAction;
}

export interface NotificationLogEntry {
  id: string;
  text: string;
  type: ToastType;
  timestamp: string;
}

export function useNotifications() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notificationLog, setNotificationLog] = useState<NotificationLogEntry[]>([]);
  const [showNotifLog, setShowNotifLog] = useState(false);
  const knownWaitingIds = useRef<Set<string> | null>(null);
  const knownRunningIds = useRef<Set<string>>(new Set());
  const knownHookStates = useRef<Map<string, string>>(new Map());
  const hookSeeded = useRef(false);
  const titleFlashTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const originalTitle = useRef(document.title);

  // Flash the page title as a fallback notification when tab is not focused.
  // Keeps flashing indefinitely until the user returns — native Notification
  // can be silently suppressed by OS-level settings, so this is the reliable
  // fallback that always fires when the tab is not focused.
  const flashTitle = useCallback((msg: string) => {
    if (document.hasFocus()) return;
    // Don't stack flashes — restart with the latest message
    if (titleFlashTimer.current) clearInterval(titleFlashTimer.current);
    originalTitle.current = document.title;
    let tick = 0;
    titleFlashTimer.current = setInterval(() => {
      tick++;
      document.title = tick % 2 === 1 ? `*** ${msg}` : originalTitle.current;
    }, TITLE_FLASH_INTERVAL);
  }, []);

  // Stop flashing when user returns to the tab (focus or visibility change)
  useEffect(() => {
    const stopFlash = () => {
      if (titleFlashTimer.current) {
        clearInterval(titleFlashTimer.current);
        titleFlashTimer.current = null;
        document.title = originalTitle.current;
      }
    };
    const onVisibility = () => { if (!document.hidden) stopFlash(); };
    window.addEventListener("focus", stopFlash);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", stopFlash);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const addToast = useCallback((text: string, type: ToastType = "info", options?: { onUndo?: () => void; action?: ToastAction; duration?: number }) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, text, type, onUndo: options?.onUndo, action: options?.action }]);
    setNotificationLog((prev) => [
      { id, text, type, timestamp: new Date().toLocaleTimeString() },
      ...prev,
    ].slice(0, 50));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, options?.duration ?? TOAST_DURATION);
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((msg: string, type: ToastType, icon: string, action?: ToastAction) => {
    addToast(msg, type, action ? { action } : undefined);
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification("Claude Todos", { body: msg, icon });
      n.onclick = () => { window.focus(); n.close(); };
    }
    // Always flash the title when tab is not focused — native notifications
    // can be silently suppressed by macOS or Linux notification settings
    flashTitle(msg);
  }, [addToast, flashTitle]);

  const notifyNewWaitingTodos = useCallback((todos: Todo[], silent?: boolean) => {
    const currentWaitingIds = new Set(
      todos.filter((t) => t.status === "waiting").map((t) => t.id)
    );
    const prev = knownWaitingIds.current;

    if (prev === null) {
      knownWaitingIds.current = currentWaitingIds;
      return;
    }

    const newWaiting = todos.filter(
      (t) => t.status === "waiting" && !prev.has(t.id)
    );

    knownWaitingIds.current = currentWaitingIds;

    if (silent || newWaiting.length === 0) return;

    for (const todo of newWaiting) {
      notify(todo.text, "warning", NOTIF_ICONS.todo);
    }
  }, [notify]);

  const notifyHookEvents = useCallback(async (projects: Project[], silent?: boolean) => {
    try {
      const events = await api.getHookEvents();
      const prev = knownHookStates.current;
      const next = new Map<string, string>();

      const isFirstPoll = !hookSeeded.current;
      if (isFirstPoll) hookSeeded.current = true;

      for (const [key, entry] of Object.entries(events)) {
        next.set(key, entry.state);

        // Seed silently on the first poll of a fresh page load — these events
        // already existed before the user opened the tab, so re-firing them on
        // every refresh just spams. The toast log still records the prior alert
        // and the user can resume the session via Claude Code directly.
        if (silent || isFirstPoll) continue;

        const prevState = prev.get(key);

        if (prevState === entry.state) continue;
        // Skip "ended" entirely — notifyRunCompletions already handles run
        // completions with richer context (todo text + project name).
        if (entry.state === "ended") continue;

        // Resolve display name: find the project by backend name, then check localStorage
        const backendName = entry.project_name || "unknown project";
        const matchedProject = projects.find((p) => p.name === backendName);
        const project = (matchedProject && getDisplayName(matchedProject.id)) || backendName;
        let msg: string;
        let type: ToastType;

        if (entry.state === "waiting_for_tool_approval") {
          const tool = entry.tool_name || "a tool";
          const detail = entry.detail ? `: ${entry.detail}` : "";
          msg = `[${project}] Waiting for approval — ${tool}${detail}`;
          type = "warning";
        } else if (entry.state === "waiting_for_user") {
          const detail = entry.detail ? `: ${entry.detail}` : "";
          msg = `[${project}] Waiting for user input${detail}`;
          type = "warning";
        } else {
          continue;
        }

        const icon = entry.state === "waiting_for_tool_approval" ? NOTIF_ICONS.approval
          : NOTIF_ICONS.user_input;
        const action: ToastAction = {
          label: "Stop watching",
          handler: () => {
            // Drop locally first so subsequent polls don't re-fire while the
            // request is in flight; the backend call is best-effort.
            knownHookStates.current.delete(key);
            api.dismissHookEvent(key).catch(() => { /* best-effort */ });
          },
        };
        notify(msg, type, icon, action);
      }

      knownHookStates.current = next;
    } catch {
      // hooks endpoint may not exist or hooks not installed — ignore
    }
  }, [notify]);

  const notifyRunCompletions = useCallback((todos: Todo[], projects: Project[], silent?: boolean) => {
    const prev = knownRunningIds.current;
    const nowRunning = new Set(
      todos.filter((t) => t.run_status === "running").map((t) => t.id)
    );

    if (!silent) {
      for (const id of prev) {
        if (!nowRunning.has(id)) {
          const todo = todos.find((t) => t.id === id);
          if (todo) {
            // Skip notification for paused (stopped) runs — the pause action
            // already shows its own toast, so a "run completed" would be redundant.
            if (todo.run_status === "stopped") continue;
            const isError = todo.run_status === "error";
            const project = projects.find((p) => p.id === todo.project_id);
            const projectLabel = project ? ` [${getDisplayName(project.id) || project.name}]` : "";
            const msg = isError ? `Run failed${projectLabel}: ${todo.text}` : `Run completed${projectLabel}: ${todo.text}`;
            notify(msg, isError ? "error" : "success", isError ? NOTIF_ICONS.run_error : NOTIF_ICONS.run_success);
          }
        }
      }
    }

    knownRunningIds.current = nowRunning;
  }, [notify]);

  return {
    toasts,
    notificationLog,
    showNotifLog,
    setShowNotifLog,
    addToast,
    dismissToast,
    notify,
    notifyNewWaitingTodos,
    notifyHookEvents,
    notifyRunCompletions,
    NOTIF_ICONS,
  };
}
