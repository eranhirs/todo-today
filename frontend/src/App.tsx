import { useCallback, useMemo, useRef, useState } from "react";
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

  useEventBus({ onRefreshNeeded: refresh });

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

  const [pendingScrollTodoId, setPendingScrollTodoId] = useState<string | null>(null);

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
            todos={state.todos}
            projects={state.projects}
            selectedProjectId={selectedProject}
          />
        ) : (
          <TodoList
            todos={state.todos}
            projects={state.projects}
            selectedProjectId={selectedProject}
            projectSummaries={state.metadata.project_summaries}
            focusedTodoId={focusedTodoId}
            editingTodoId={editingTodoId}
            addInputRef={addInputRef}
            completedTotal={selectedProject ? (state.completed_by_project?.[selectedProject] ?? 0) : state.completed_total}
            hasMoreCompleted={selectedProject ? ((state.completed_by_project?.[selectedProject] ?? 0) > state.todos.filter(t => t.project_id === selectedProject && t.status === "completed").length) : state.has_more_completed}
            onLoadMoreCompleted={loadMoreCompleted}
            loadingMoreCompleted={loadingMore}
            unreadCounts={state.unread_counts ?? {}}
            globalRunModel={state.settings.run_model}
            sessionAutopilot={state.session_autopilot ?? {}}
            analysisHistory={state.metadata.history}
            onNavigateToTodo={handleNavigateToTodo}
            pendingScrollTodoId={pendingScrollTodoId}
            onPendingScrollHandled={handlePendingScrollHandled}
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
