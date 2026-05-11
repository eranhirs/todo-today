import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectList } from "./components/ProjectList";
import { TodoList } from "./components/TodoList";
import { Dashboard } from "./components/Dashboard";
import { SkillList } from "./components/SkillList";
import { ClaudeStatus } from "./components/ClaudeStatus";
import { UpdateHistory } from "./components/UpdateHistory";
import { AutopilotHistory } from "./components/AutopilotHistory";
import { HookDebug } from "./components/HookDebug";
import { TokenTracker } from "./components/TokenTracker";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay";
import { Insights } from "./components/Insights";
import { useNotifications, NOTIF_ICONS } from "./hooks/useNotifications";
import { useAppState } from "./hooks/useAppState";
import { useEventBus } from "./hooks/useEventBus";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { AppProvider, type AppContextValue } from "./contexts/AppContext";
import { useClickOutside } from "./hooks/useClickOutside";
import { isStaticDemo } from "./api";
import { PINNED_VIEW_ID } from "./types";
import "./App.css";

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarMinimized, setSidebarMinimized] = useState(isStaticDemo);

  const {
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
    notifyRunForTodo,
    clearRunNotification,
  } = useNotifications();

  const {
    state,
    setState,
    selectedProject,
    selectProject,
    view,
    switchView,
    refresh,
    optimisticUpdate,
    isOffline,
    loadMoreCompleted,
    loadingMore,
    optimistic,
  } = useAppState({
    notifyNewWaitingTodos,
    notifyRunCompletions,
    notifyHookEvents,
  });

  // Mirror state into a ref so SSE event handlers (which subscribe once) can
  // read the current todos/projects when an event fires.
  const stateRef = useRef(state);
  stateRef.current = state;

  const { subscribe } = useEventBus({ onRefreshNeeded: refresh });

  // Fire run-completion browser notifications directly from SSE events.
  // The polling-driven `notifyRunCompletions` path can miss notifications when:
  //   1. The tab is hidden — `triggerRefresh` defers the refresh, and the
  //      eventual refresh on return is forced silent to avoid stale bursts.
  //   2. A run is fast enough that the running→done transition happens within
  //      a single 500ms refresh debounce window, so polling never observes
  //      "running" and thus has no transition to react to.
  // Both paths share `recentlyNotifiedRunIds` for dedup.
  useEffect(() => {
    const fire = (outcome: "success" | "error") => (e: { data: Record<string, unknown> }) => {
      const todoId = e.data.todo_id as string | undefined;
      if (!todoId) return;
      const s = stateRef.current;
      if (!s) return;
      const todo = s.todos.find((t) => t.id === todoId);
      if (!todo) return;
      notifyRunForTodo(todo, s.projects, outcome);
    };
    const handleStart = (e: { data: Record<string, unknown> }) => {
      const todoId = e.data.todo_id as string | undefined;
      if (todoId) clearRunNotification(todoId);
    };
    const unsubs = [
      subscribe("run.completed", fire("success")),
      subscribe("run.failed", fire("error")),
      subscribe("run.started", handleStart),
    ];
    return () => { for (const u of unsubs) u(); };
  }, [subscribe, notifyRunForTodo, clearRunNotification]);

  const {
    showShortcuts,
    setShowShortcuts,
    focusedTodoId,
    editingTodoId,
    addInputRef,
  } = useKeyboardShortcuts({
    state,
    view,
    selectedProject,
    setState,
    refresh,
    addToast,
    isOffline,
    optimistic,
  });

  // `focus=<id>` URL param (set when a parent jump opens a new tab with cleared
  // filters) tells us to scroll to that todo on initial load. We strip it after
  // reading so a refresh doesn't re-trigger the scroll. `openedFromFocus` stays
  // true for the lifetime of the tab so the pending-scroll fallback can avoid
  // recursively spawning more tabs from a tab that was itself focus-opened.
  const [openedFromFocus] = useState<boolean>(() =>
    new URLSearchParams(window.location.search).has("focus")
  );
  const [pendingScrollTodoId, setPendingScrollTodoId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const focus = params.get("focus");
    if (focus) {
      const url = new URL(window.location.href);
      url.searchParams.delete("focus");
      window.history.replaceState({}, "", url.toString());
    }
    return focus;
  });

  const handleNavigateToTodo = useCallback((todoId: string, projectId: string) => {
    selectProject(projectId);
    if (view !== "list") switchView("list");
    setPendingScrollTodoId(todoId);
  }, [selectProject, view, switchView]);

  const handlePendingScrollHandled = useCallback(() => {
    setPendingScrollTodoId(null);
  }, []);

  const [showInsightsDropdown, setShowInsightsDropdown] = useState(false);
  const insightsDropdownRef = useRef<HTMLDivElement | null>(null);

  const closeInsightsDropdown = useCallback(() => setShowInsightsDropdown(false), []);
  useClickOutside(insightsDropdownRef, closeInsightsDropdown, showInsightsDropdown);

  const appContextValue = useMemo<AppContextValue>(() => ({
    addToast,
    onRefresh: refresh,
    onOptimisticUpdate: optimisticUpdate,
    optimistic,
    isOffline,
  }), [addToast, refresh, optimisticUpdate, optimistic, isOffline]);

  const inPinnedView = selectedProject === PINNED_VIEW_ID;

  const pinnedIds = useMemo(() => {
    if (!state) return new Set<string>();
    return new Set(state.projects.filter((p) => p.pinned).map((p) => p.id));
  }, [state]);

  // In pinned view we treat the list as "all projects of pinned only" — children
  // see selectedProjectId=null and the todos list pre-filtered to pinned projects.
  const effectiveSelectedProjectId = inPinnedView ? null : selectedProject;
  const viewTodos = useMemo(() => {
    if (!state) return [];
    if (!inPinnedView) return state.todos;
    return state.todos.filter((t) => pinnedIds.has(t.project_id));
  }, [state, inPinnedView, pinnedIds]);
  const pinnedCompletedTotal = useMemo(() => {
    if (!state || !inPinnedView) return 0;
    let total = 0;
    for (const id of pinnedIds) total += state.completed_by_project?.[id] ?? 0;
    return total;
  }, [state, inPinnedView, pinnedIds]);
  const pinnedUnreadCounts = useMemo(() => {
    if (!state) return {};
    if (!inPinnedView) return state.unread_counts ?? {};
    const counts: Record<string, number> = {};
    let total = 0;
    for (const [pid, n] of Object.entries(state.unread_counts ?? {})) {
      if (pid === "_total") continue;
      if (pinnedIds.has(pid)) {
        counts[pid] = n;
        total += n;
      }
    }
    counts["_total"] = total;
    return counts;
  }, [state, inPinnedView, pinnedIds]);

  if (!state) return <div className="loading">Loading...</div>;

  return (
    <AppProvider value={appContextValue}>
    <div className="app">
      {isStaticDemo && (
        <div className="demo-banner">
          You're viewing a read-only demo &mdash;{" "}
          <a href="https://github.com/eranhirs/claude-todos#claude-todos" target="_blank" rel="noopener noreferrer">
            Install your own on GitHub
            <svg className="demo-banner-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
        </div>
      )}
      {isOffline && (
        <div className="offline-banner">
          Server unreachable — you can still add items, but updates are disabled until reconnected
        </div>
      )}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.type}`}>
              <span className="toast-text">{t.text}</span>
              {t.onUndo && (
                <button className="toast-undo" onClick={() => { t.onUndo!(); dismissToast(t.id); }}>Undo</button>
              )}
              {t.action && (
                <button className="toast-action" onClick={() => { t.action!.handler(); dismissToast(t.id); }}>{t.action.label}</button>
              )}
              <button className="toast-dismiss" onClick={() => dismissToast(t.id)}>&times;</button>
            </div>
          ))}
        </div>
      )}
      <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle sidebar">
        <span className="hamburger-icon" />
      </button>
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? " sidebar-open" : ""}${sidebarMinimized ? " sidebar-minimized" : ""}`}>
        <div className="sidebar-header">
          <h1 className="app-title">Claude Todos</h1>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarMinimized((v) => !v)}
            title={sidebarMinimized ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {sidebarMinimized
                ? <polyline points="6 3 11 8 6 13" />
                : <polyline points="11 3 6 8 11 13" />
              }
            </svg>
          </button>
        </div>
        <ClaudeStatus metadata={state.metadata} settings={state.settings} analysisLocked={state.analysis_locked} autopilotRunning={state.autopilot_running} onRefresh={refresh} />
        <TokenTracker metadata={state.metadata} onRefresh={refresh} />
        <ProjectList
          projects={state.projects}
          todos={state.todos}
          selectedId={selectedProject}
          onSelect={(id) => { selectProject(id); setSidebarOpen(false); }}
          onRefresh={refresh}
          unreadCounts={state.unread_counts ?? {}}
        />
        <UpdateHistory history={state.metadata.history} />
        <AutopilotHistory
          todos={viewTodos}
          projects={state.projects}
          selectedProjectId={effectiveSelectedProjectId}
        />
        <div className="notif-log-section">
          <button className="btn-link notif-log-toggle" onClick={() => setShowNotifLog((v) => !v)}>
            {showNotifLog ? "▾" : "▸"} Notifications ({notificationLog.length})
          </button>
          <button
            className="btn-link"
            style={{ marginLeft: 8, fontSize: "0.75rem", opacity: 0.7 }}
            onClick={async () => {
              const log = (msg: string) => { console.warn("[notif-diag]", msg); };

              if (!("Notification" in window)) {
                log("Notification API is not present on window");
                addToast("✗ Browser does not support the Notification API", "error", { duration: 20_000 });
                return;
              }
              log(`Notification API present. userAgent=${navigator.userAgent}`);

              if (!window.isSecureContext) {
                log("Page is not a secure context — Notification API blocks non-HTTPS/non-localhost origins");
                addToast("✗ Not a secure context (need HTTPS or localhost) — Notification API will be blocked", "error", { duration: 20_000 });
                return;
              }
              log(`Secure context OK. origin=${window.location.origin}`);

              let perm = Notification.permission;
              log(`Initial permission state: ${perm}`);
              addToast(`Permission: ${perm}`, perm === "granted" ? "success" : "warning");

              if (perm === "default") {
                addToast("Requesting notification permission…", "info");
                try {
                  perm = await Notification.requestPermission();
                  log(`Permission after request: ${perm}`);
                  addToast(`After request: ${perm}`, perm === "granted" ? "success" : "warning");
                } catch (err) {
                  log(`requestPermission threw: ${err}`);
                  addToast(`✗ requestPermission failed: ${err}`, "error", { duration: 20_000 });
                  return;
                }
              }

              if (perm === "denied") {
                addToast("✗ Permission denied — open the site settings (lock icon) and allow notifications, then reload", "error", { duration: 30_000 });
                return;
              }
              if (perm !== "granted") {
                addToast(`✗ Cannot proceed — permission is "${perm}"`, "error", { duration: 20_000 });
                return;
              }

              addToast("Firing test notification now (no delay)…", "info");
              let shown = false;
              let errored = false;
              try {
                const n = new Notification("Claude Todos — Diagnostic", {
                  body: "If you see this, browser notifications work. ✓",
                  icon: NOTIF_ICONS.todo,
                  tag: "claude-todos-diagnostic",
                  requireInteraction: false,
                });
                log("Notification constructor returned without throwing");
                n.onshow = () => {
                  shown = true;
                  log("onshow fired — browser displayed the notification");
                };
                n.onerror = (e) => {
                  errored = true;
                  log(`onerror fired: ${JSON.stringify(e)}`);
                };
                n.onclick = () => { window.focus(); n.close(); };
                n.onclose = () => log("onclose fired");

                setTimeout(() => {
                  if (errored) {
                    addToast("✗ Notification fired but reported an error — check console", "error", { duration: 30_000 });
                  } else if (shown) {
                    addToast("✓ Notification was shown by the browser. If you didn't see it, check OS Do-Not-Disturb / focus mode / notification center.", "success", { duration: 30_000 });
                  } else {
                    addToast("? onshow never fired within 1.5s — the browser likely suppressed it (OS Do-Not-Disturb, focus mode, or browser background-tab throttling). Check console for details.", "warning", { duration: 30_000 });
                    log("onshow did not fire within 1.5s — likely OS-level suppression. On Linux check ~/.config/dunst, GNOME Do-Not-Disturb, or browser-level notification settings. On macOS check System Settings → Notifications → <browser>. Some browsers also suppress notifications when the page is focused or after recent dismissal.");
                  }
                  log(`document.hasFocus=${document.hasFocus()}, document.hidden=${document.hidden}, visibilityState=${document.visibilityState}`);
                }, 1500);
              } catch (err: any) {
                log(`Notification constructor threw: ${err?.message ?? err}`);
                addToast(`✗ Notification constructor threw: ${err?.message ?? err}`, "error", { duration: 30_000 });
                return;
              }

              setTimeout(() => {
                addToast("Firing 2nd notification in 3s — switch to another tab to test background delivery!", "info");
                setTimeout(() => {
                  notify("[Test] Background-tab notification", "warning", NOTIF_ICONS.todo);
                  log("Fired delayed notification via notify()");
                }, 3000);
              }, 2000);
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
          const filteredInsights = inPinnedView
            ? allInsights.filter((i) => pinnedIds.has(i.project_id) || i.project_id === "")
            : selectedProject
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
                  <button
                    className={`view-toggle-btn${view === "skills" ? " active" : ""}`}
                    onClick={() => switchView("skills")}
                  >
                    Skills
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
            completedTotal={state.completed_total}
          />
        ) : view === "skills" ? (
          <SkillList
            todos={viewTodos}
            projects={state.projects}
            selectedProjectId={effectiveSelectedProjectId}
          />
        ) : (
          <TodoList
            todos={viewTodos}
            projects={state.projects}
            selectedProjectId={effectiveSelectedProjectId}
            viewLabel={inPinnedView ? "All Pinned Projects" : null}
            projectsForAdd={inPinnedView ? state.projects.filter((p) => p.pinned) : state.projects}
            projectSummaries={state.metadata.project_summaries}
            focusedTodoId={focusedTodoId}
            editingTodoId={editingTodoId}
            addInputRef={addInputRef}
            completedTotal={inPinnedView ? pinnedCompletedTotal : (selectedProject ? (state.completed_by_project?.[selectedProject] ?? 0) : state.completed_total)}
            hasMoreCompleted={inPinnedView ? (pinnedCompletedTotal > viewTodos.filter(t => t.status === "completed").length) : (selectedProject ? ((state.completed_by_project?.[selectedProject] ?? 0) > state.todos.filter(t => t.project_id === selectedProject && t.status === "completed").length) : state.has_more_completed)}
            onLoadMoreCompleted={loadMoreCompleted}
            loadingMoreCompleted={loadingMore}
            unreadCounts={pinnedUnreadCounts}
            globalRunModel={state.settings.run_model}
            globalRunEffort={state.settings.run_effort}
            sessionAutopilot={state.session_autopilot ?? {}}
            analysisHistory={state.metadata.history}
            onNavigateToTodo={handleNavigateToTodo}
            pendingScrollTodoId={pendingScrollTodoId}
            onPendingScrollHandled={handlePendingScrollHandled}
            openedFromFocus={openedFromFocus}
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
    </AppProvider>
  );
}

export default App;
