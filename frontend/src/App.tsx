import { useEffect, useState, useCallback, useRef } from "react";
import type { FullState, Todo } from "./types";
import { api } from "./api";
import { ProjectList } from "./components/ProjectList";
import { TodoList } from "./components/TodoList";
import { Dashboard } from "./components/Dashboard";
import { ClaudeStatus } from "./components/ClaudeStatus";
import { UpdateHistory } from "./components/UpdateHistory";
import { HookDebug } from "./components/HookDebug";
import "./App.css";

const POLL_INTERVAL = 3_000;
const TOAST_DURATION = 12_000;

/* SVG data-URI icons for browser notifications, one per event type */
const svgIcon = (emoji: string, bg: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" rx="12" fill="${bg}"/>` +
    `<text x="32" y="46" font-size="36" text-anchor="middle">${emoji}</text>` +
    `</svg>`
  )}`;

const NOTIF_ICONS = {
  todo:           svgIcon("📋", "#3b82f6"),  // blue  — new waiting todo
  approval:       svgIcon("🔑", "#f59e0b"),  // amber — waiting for tool approval
  user_input:     svgIcon("💬", "#f59e0b"),  // amber — waiting for user input
  ended:          svgIcon("✅", "#22c55e"),  // green — session finished
  run_success:    svgIcon("✅", "#22c55e"),  // green — run succeeded
  run_error:      svgIcon("❌", "#ef4444"),  // red   — run failed
} as const;

type ToastType = "info" | "warning" | "success" | "error";

interface Toast {
  id: string;
  text: string;
  type: ToastType;
}

interface NotificationLogEntry {
  id: string;
  text: string;
  type: ToastType;
  timestamp: string;
}

function App() {
  const [state, setState] = useState<FullState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notificationLog, setNotificationLog] = useState<NotificationLogEntry[]>([]);
  const [showNotifLog, setShowNotifLog] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("project");
  });
  const [view, setView] = useState<"list" | "dashboard">(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("view") === "dashboard" ? "dashboard" : "list";
  });

  const selectProject = useCallback((id: string | null) => {
    setSelectedProject(id);
    const url = new URL(window.location.href);
    if (id) {
      url.searchParams.set("project", id);
    } else {
      url.searchParams.delete("project");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  const switchView = useCallback((v: "list" | "dashboard") => {
    setView(v);
    const url = new URL(window.location.href);
    if (v === "dashboard") {
      url.searchParams.set("view", "dashboard");
    } else {
      url.searchParams.delete("view");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  const knownWaitingIds = useRef<Set<string> | null>(null);
  const knownRunningIds = useRef<Set<string>>(new Set());
  const knownHookStates = useRef<Map<string, string>>(new Map());

  const addToast = useCallback((text: string, type: ToastType = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, text, type }]);
    setNotificationLog((prev) => [
      { id, text, type, timestamp: new Date().toLocaleTimeString() },
      ...prev,
    ].slice(0, 50));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notifyNewWaitingTodos = useCallback((todos: Todo[]) => {
    const currentWaitingIds = new Set(
      todos.filter((t) => t.status === "waiting").map((t) => t.id)
    );
    const prev = knownWaitingIds.current;

    if (prev === null) {
      // First load — seed known set without toasting
      knownWaitingIds.current = currentWaitingIds;
      return;
    }

    const newWaiting = todos.filter(
      (t) => t.status === "waiting" && !prev.has(t.id)
    );

    knownWaitingIds.current = currentWaitingIds;

    if (newWaiting.length === 0) return;

    // In-app toast (always works)
    for (const todo of newWaiting) {
      addToast(todo.text, "warning");
    }

    // Browser notification (best-effort)
    if ("Notification" in window && Notification.permission === "granted") {
      for (const todo of newWaiting) {
        const body = todo.session_id
          ? `${todo.text}\n(session: ${todo.session_id.slice(0, 8)}…)`
          : todo.text;
        const n = new Notification("Claude Todos", { body, icon: NOTIF_ICONS.todo });
        n.onclick = () => { window.focus(); n.close(); };
      }
    }
  }, [addToast]);

  const hookSeeded = useRef(false);

  const notifyHookEvents = useCallback(async () => {
    try {
      const events = await api.getHookEvents();
      const prev = knownHookStates.current;
      const next = new Map<string, string>();

      const isFirstPoll = !hookSeeded.current;
      if (isFirstPoll) hookSeeded.current = true;

      for (const [key, entry] of Object.entries(events)) {
        next.set(key, entry.state);
        const prevState = prev.get(key);

        // Skip if state unchanged
        if (prevState === entry.state) continue;

        // On first poll, only notify for active waiting states (not ended)
        if (isFirstPoll && entry.state === "ended") continue;

        const project = entry.project_name || "unknown project";
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
        } else if (entry.state === "ended") {
          const detail = entry.detail ? `: ${entry.detail}` : "";
          msg = `[${project}] Session finished${detail}`;
          type = "success";
        } else {
          continue;
        }

        addToast(msg, type);

        if ("Notification" in window && Notification.permission === "granted") {
          const icon = entry.state === "waiting_for_tool_approval" ? NOTIF_ICONS.approval
            : entry.state === "waiting_for_user" ? NOTIF_ICONS.user_input
            : NOTIF_ICONS.ended;
          const n = new Notification(`Claude Todos — ${project}`, { body: msg, icon });
          n.onclick = () => { window.focus(); n.close(); };
        }
      }

      knownHookStates.current = next;
    } catch {
      // hooks endpoint may not exist or hooks not installed — ignore
    }
  }, [addToast]);

  const notifyRunCompletions = useCallback((todos: Todo[]) => {
    const prev = knownRunningIds.current;
    const nowRunning = new Set(
      todos.filter((t) => t.run_status === "running").map((t) => t.id)
    );

    // Check todos that were running before but aren't anymore
    for (const id of prev) {
      if (!nowRunning.has(id)) {
        const todo = todos.find((t) => t.id === id);
        if (todo) {
          const isError = todo.run_status === "error";
          addToast(isError ? `Run failed: ${todo.text}` : `Run completed: ${todo.text}`, isError ? "error" : "success");
          if ("Notification" in window && Notification.permission === "granted") {
            const n = new Notification("Claude Todos", {
              body: isError ? `Run failed: ${todo.text}` : `Run completed: ${todo.text}`,
              icon: isError ? NOTIF_ICONS.run_error : NOTIF_ICONS.run_success,
            });
            n.onclick = () => { window.focus(); n.close(); };
          }
        }
      }
    }

    knownRunningIds.current = nowRunning;
  }, [addToast]);

  // Use a ref to always call the latest callbacks without re-creating the interval
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  refreshRef.current = async () => {
    try {
      const data = await api.getState();
      setState(data);
      notifyNewWaitingTodos(data.todos);
      notifyRunCompletions(data.todos);
      notifyHookEvents();
      const waitingCount = data.todos.filter((t) => t.status === "waiting").length;
      document.title = waitingCount > 0 ? `(${waitingCount}) Claude Todos` : "Claude Todos";
    } catch (err) {
      console.error("Failed to fetch state:", err);
    }
  };

  const refresh = useCallback(async () => {
    await refreshRef.current?.();
  }, []);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  if (!state) return <div className="loading">Loading...</div>;

  return (
    <div className="app">
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.type}`}>
              <span className="toast-text">{t.text}</span>
              <button className="toast-dismiss" onClick={() => dismissToast(t.id)}>&times;</button>
            </div>
          ))}
        </div>
      )}
      <aside className="sidebar">
        <h1 className="app-title">Claude Todos</h1>
        <ClaudeStatus metadata={state.metadata} analysisLocked={state.analysis_locked} onRefresh={refresh} />
        <ProjectList
          projects={state.projects}
          selectedId={selectedProject}
          onSelect={selectProject}
          onRefresh={refresh}
        />
        <UpdateHistory history={state.metadata.history} />
        <div className="notif-log-section">
          <button className="btn-link notif-log-toggle" onClick={() => setShowNotifLog((v) => !v)}>
            {showNotifLog ? "▾" : "▸"} Notifications ({notificationLog.length})
          </button>
          <button
            className="btn-link"
            style={{ marginLeft: 8, fontSize: "0.75rem", opacity: 0.7 }}
            onClick={() => {
              if (!("Notification" in window) || Notification.permission !== "granted") {
                addToast("Browser notifications not permitted", "error");
                return;
              }
              const samples: [string, string, keyof typeof NOTIF_ICONS][] = [
                ["New waiting todo", "Refactor auth module", "todo"],
                ["Waiting for approval", "Bash: rm -rf node_modules", "approval"],
                ["Waiting for user input", "Which database should I use?", "user_input"],
                ["Session finished", "Completed 3 tasks", "ended"],
                ["Run completed", "Deploy script succeeded", "run_success"],
                ["Run failed", "Tests failed with 2 errors", "run_error"],
              ];
              // Cycle through one at a time to avoid browser rate-limiting
              const idx = (window as any).__notifTestIdx ?? 0;
              const [title, body, key] = samples[idx % samples.length];
              (window as any).__notifTestIdx = idx + 1;
              const n = new Notification(`Claude Todos — ${title}`, { body, icon: NOTIF_ICONS[key] });
              n.onclick = () => { window.focus(); n.close(); };
              addToast(`Test: ${title}`, "info");
            }}
          >
            Test
          </button>
          {showNotifLog && (
            <div className="notif-log">
              {notificationLog.length === 0 ? (
                <div className="notif-log-empty">No notifications yet</div>
              ) : (
                notificationLog.map((n) => (
                  <div key={n.id} className={`notif-log-entry notif-${n.type}`}>
                    <span className="notif-log-time">{n.timestamp}</span>
                    <span className="notif-log-text">{n.text}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <HookDebug />
      </aside>
      <main className="main">
        <div className="view-toggle">
          <button
            className={`view-toggle-btn${view === "list" ? " active" : ""}`}
            onClick={() => switchView("list")}
          >
            List
          </button>
          <button
            className={`view-toggle-btn${view === "dashboard" ? " active" : ""}`}
            onClick={() => switchView("dashboard")}
          >
            Dashboard
          </button>
        </div>
        {view === "dashboard" ? (
          <Dashboard
            todos={state.todos}
            projects={state.projects}
            projectSummaries={state.metadata.project_summaries}
            history={state.metadata.history}
            onSelectProject={(id) => { selectProject(id); switchView("list"); }}
          />
        ) : (
          <TodoList
            todos={state.todos}
            projects={state.projects}
            selectedProjectId={selectedProject}
            projectSummaries={state.metadata.project_summaries}
            insights={state.metadata.insights}
            onRefresh={refresh}
          />
        )}
      </main>
    </div>
  );
}

export default App;
