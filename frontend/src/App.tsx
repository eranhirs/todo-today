import { useEffect, useState, useCallback, useRef } from "react";
import type { FullState, Todo } from "./types";
import { api } from "./api";
import { ProjectList } from "./components/ProjectList";
import { TodoList } from "./components/TodoList";
import { Dashboard } from "./components/Dashboard";
import { ClaudeStatus } from "./components/ClaudeStatus";
import { UpdateHistory } from "./components/UpdateHistory";
import { AutopilotHistory } from "./components/AutopilotHistory";
import { HookDebug } from "./components/HookDebug";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay";
import { Insights } from "./components/Insights";
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

  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showInsightsDropdown, setShowInsightsDropdown] = useState(false);
  const [focusedTodoId, setFocusedTodoId] = useState<string | null>(null);
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const addInputRef = useRef<HTMLTextAreaElement | null>(null);
  const insightsDropdownRef = useRef<HTMLDivElement | null>(null);

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

  /** Send both an in-app toast and a browser notification with identical content */
  const notify = useCallback((msg: string, type: ToastType, icon: string) => {
    addToast(msg, type);
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification("Claude Todos", { body: msg, icon });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }, [addToast]);

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

    for (const todo of newWaiting) {
      notify(todo.text, "warning", NOTIF_ICONS.todo);
    }
  }, [notify]);

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

        const icon = entry.state === "waiting_for_tool_approval" ? NOTIF_ICONS.approval
          : entry.state === "waiting_for_user" ? NOTIF_ICONS.user_input
          : NOTIF_ICONS.ended;
        notify(msg, type, icon);
      }

      knownHookStates.current = next;
    } catch {
      // hooks endpoint may not exist or hooks not installed — ignore
    }
  }, [notify]);

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
          const msg = isError ? `Run failed: ${todo.text}` : `Run completed: ${todo.text}`;
          notify(msg, isError ? "error" : "success", isError ? NOTIF_ICONS.run_error : NOTIF_ICONS.run_success);
        }
      }
    }

    knownRunningIds.current = nowRunning;
  }, [notify]);

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

  // Build flat ordered list of visible todos (mirrors TodoList render order)
  const getVisibleTodos = useCallback((): Todo[] => {
    if (!state || view !== "list") return [];
    const filtered = selectedProject
      ? state.todos.filter((t) => t.project_id === selectedProject)
      : state.todos;

    const sortByOrder = (a: Todo, b: Todo) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return b.created_at.localeCompare(a.created_at);
    };

    const upNextOrder = { waiting: 0, in_progress: 1, next: 2 } as const;
    const upNext = filtered
      .filter((t) => t.status === "waiting" || t.status === "in_progress" || t.status === "next")
      .sort((a, b) => {
        const oa = upNextOrder[a.status as keyof typeof upNextOrder] ?? 2;
        const ob = upNextOrder[b.status as keyof typeof upNextOrder] ?? 2;
        if (oa !== ob) return oa - ob;
        return sortByOrder(a, b);
      });

    const backlog = filtered
      .filter((t) => t.status === "consider" || t.status === "stale")
      .sort((a, b) => {
        if (a.status === "consider" && b.status === "stale") return -1;
        if (a.status === "stale" && b.status === "consider") return 1;
        return sortByOrder(a, b);
      });

    const done = filtered
      .filter((t) => t.status === "completed")
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));

    return [...upNext, ...backlog, ...done];
  }, [state, view, selectedProject]);

  const STATUS_KEYS: Record<string, Todo["status"]> = {
    "1": "next",
    "2": "in_progress",
    "3": "completed",
    "4": "consider",
    "5": "waiting",
  };

  // Global keyboard shortcut handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // ? always toggles overlay
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        if (isInput) return;
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      // Escape: close overlay, clear focus, or blur input
      if (e.key === "Escape") {
        if (showShortcuts) {
          setShowShortcuts(false);
          return;
        }
        if (isInput) {
          (e.target as HTMLElement).blur();
          return;
        }
        setFocusedTodoId(null);
        setEditingTodoId(null);
        return;
      }

      // Skip other shortcuts when typing in an input
      if (isInput) return;
      // Skip when overlay is showing
      if (showShortcuts) return;

      const todos = getVisibleTodos();

      if (e.key === "n") {
        e.preventDefault();
        addInputRef.current?.focus();
        setFocusedTodoId(null);
        return;
      }

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (todos.length === 0) return;
        setEditingTodoId(null);
        if (focusedTodoId === null) {
          setFocusedTodoId(todos[0].id);
        } else {
          const idx = todos.findIndex((t) => t.id === focusedTodoId);
          if (idx < todos.length - 1) {
            setFocusedTodoId(todos[idx + 1].id);
          }
        }
        return;
      }

      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (todos.length === 0) return;
        setEditingTodoId(null);
        if (focusedTodoId === null) {
          setFocusedTodoId(todos[todos.length - 1].id);
        } else {
          const idx = todos.findIndex((t) => t.id === focusedTodoId);
          if (idx > 0) {
            setFocusedTodoId(todos[idx - 1].id);
          }
        }
        return;
      }

      // Status shortcuts 1-5
      if (STATUS_KEYS[e.key] && focusedTodoId) {
        e.preventDefault();
        const newStatus = STATUS_KEYS[e.key];
        // Optimistic update + API call
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            todos: prev.todos.map((t) =>
              t.id === focusedTodoId ? { ...t, status: newStatus } : t
            ),
          };
        });
        api.updateTodo(focusedTodoId, { status: newStatus }).then(() => refresh());
        return;
      }

      if (e.key === "e" && focusedTodoId) {
        e.preventDefault();
        setEditingTodoId(focusedTodoId);
        // Reset after a tick so the TodoItem can pick it up
        setTimeout(() => setEditingTodoId(null), 100);
        return;
      }

      if (e.key === "x" && focusedTodoId) {
        e.preventDefault();
        const idToDelete = focusedTodoId;
        // Move focus to next item
        const idx = todos.findIndex((t) => t.id === idToDelete);
        const nextId = idx < todos.length - 1 ? todos[idx + 1].id : (idx > 0 ? todos[idx - 1].id : null);
        setFocusedTodoId(nextId);
        setState((prev) => {
          if (!prev) return prev;
          return { ...prev, todos: prev.todos.filter((t) => t.id !== idToDelete) };
        });
        api.deleteTodo(idToDelete).then(() => refresh());
        return;
      }

      if (e.key === "r" && focusedTodoId) {
        e.preventDefault();
        api.runTodo(focusedTodoId).then(() => {
          addToast(`Started running todo with Claude`, "info");
          refresh();
        });
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showShortcuts, focusedTodoId, getVisibleTodos, refresh, addToast]);

  // Close insights dropdown on outside click
  useEffect(() => {
    if (!showInsightsDropdown) return;
    const handler = (e: MouseEvent) => {
      if (insightsDropdownRef.current && !insightsDropdownRef.current.contains(e.target as Node)) {
        setShowInsightsDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showInsightsDropdown]);

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
        <ClaudeStatus metadata={state.metadata} analysisLocked={state.analysis_locked} autopilotRunning={state.autopilot_running} onRefresh={refresh} />
        <ProjectList
          projects={state.projects}
          todos={state.todos}
          selectedId={selectedProject}
          onSelect={selectProject}
          onRefresh={refresh}
        />
        <UpdateHistory history={state.metadata.history} />
        <AutopilotHistory
          todos={state.todos}
          projects={state.projects}
          selectedProjectId={selectedProject}
        />
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
              // Fire after 3s so user can switch tabs (Chrome suppresses
              // notifications when the page is focused)
              addToast("Notification in 3s — switch to another tab!", "info");
              setTimeout(() => {
                const idx = (window as any).__notifTestIdx ?? 0;
                const [, body, key] = samples[idx % samples.length];
                (window as any).__notifTestIdx = idx + 1;
                notify(`[Test] ${body}`, idx % 2 === 0 ? "warning" : "success", NOTIF_ICONS[key]);
              }, 3000);
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
        {(() => {
          const allInsights = state.metadata.insights;
          const filteredInsights = selectedProject
            ? allInsights.filter((i) => i.project_id === selectedProject || i.project_id === "")
            : allInsights;
          const activeInsights = filteredInsights.filter((i) => !i.dismissed);
          const activeCount = activeInsights.length;
          return (
            <>
              <div className="main-toolbar">
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
                <div className="insights-bell-wrapper" ref={insightsDropdownRef}>
                  <button
                    className={`insights-bell${activeCount > 0 ? " has-insights" : ""}`}
                    onClick={() => setShowInsightsDropdown((v) => !v)}
                    title={activeCount > 0 ? `${activeCount} insight${activeCount !== 1 ? "s" : ""}` : "No insights"}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                    {activeCount > 0 && <span className="insights-badge">{activeCount}</span>}
                  </button>
                  {showInsightsDropdown && (
                    <div className="insights-dropdown">
                      <Insights insights={filteredInsights} onRefresh={refresh} />
                      {activeCount === 0 && (
                        <div className="insights-dropdown-empty">No active insights</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}
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
            onRefresh={refresh}
            addToast={addToast}
            onOptimisticUpdate={(fn) => setState((prev) => prev ? { ...prev, todos: fn(prev.todos) } : prev)}
            focusedTodoId={focusedTodoId}
            editingTodoId={editingTodoId}
            addInputRef={addInputRef}
          />
        )}
      </main>
      {showShortcuts && <KeyboardShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
      <button
        className="shortcuts-hint"
        onClick={() => setShowShortcuts(true)}
        title="Keyboard shortcuts (?)"
      >?</button>
    </div>
  );
}

export default App;
