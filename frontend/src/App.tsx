import { useEffect, useRef, useState } from "react";
import { ProjectList } from "./components/ProjectList";
import { TodoList } from "./components/TodoList";
import { Dashboard } from "./components/Dashboard";
import { ClaudeStatus } from "./components/ClaudeStatus";
import { UpdateHistory } from "./components/UpdateHistory";
import { AutopilotHistory } from "./components/AutopilotHistory";
import { HookDebug } from "./components/HookDebug";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay";
import { Insights } from "./components/Insights";
import { useNotifications, NOTIF_ICONS } from "./hooks/useNotifications";
import { useAppState } from "./hooks/useAppState";
import { useEventBus } from "./hooks/useEventBus";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import "./App.css";

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
  });

  const [showInsightsDropdown, setShowInsightsDropdown] = useState(false);
  const insightsDropdownRef = useRef<HTMLDivElement | null>(null);

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

  if (!state) return <div className="loading">Loading...</div>;

  return (
    <div className="app">
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
              <button className="toast-dismiss" onClick={() => dismissToast(t.id)}>&times;</button>
            </div>
          ))}
        </div>
      )}
      <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle sidebar">
        <span className="hamburger-icon" />
      </button>
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? " sidebar-open" : ""}`}>
        <h1 className="app-title">Claude Todos</h1>
        <ClaudeStatus metadata={state.metadata} settings={state.settings} analysisLocked={state.analysis_locked} autopilotRunning={state.autopilot_running} onRefresh={refresh} />
        <ProjectList
          projects={state.projects}
          todos={state.todos}
          selectedId={selectedProject}
          onSelect={(id) => { selectProject(id); setSidebarOpen(false); }}
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
            onOptimisticUpdate={optimisticUpdate}
            focusedTodoId={focusedTodoId}
            editingTodoId={editingTodoId}
            addInputRef={addInputRef}
            isOffline={isOffline}
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
