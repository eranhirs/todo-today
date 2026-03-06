import { useEffect, useState, useCallback, useRef } from "react";
import type { FullState, Todo } from "./types";
import { api } from "./api";
import { ProjectList } from "./components/ProjectList";
import { TodoList } from "./components/TodoList";
import { ClaudeStatus } from "./components/ClaudeStatus";
import { UpdateHistory } from "./components/UpdateHistory";
import "./App.css";

const POLL_INTERVAL = 3_000;
const TOAST_DURATION = 6_000;

interface Toast {
  id: string;
  text: string;
}

function App() {
  const [state, setState] = useState<FullState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("project");
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

  const knownWaitingIds = useRef<Set<string> | null>(null);
  const knownRunningIds = useRef<Set<string>>(new Set());

  const addToast = useCallback((text: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION);
  }, []);

  const notifyNewWaitingTodos = useCallback((todos: Todo[]) => {
    const currentWaitingIds = new Set(
      todos.filter((t) => t.status === "waiting").map((t) => t.id)
    );
    const prev = knownWaitingIds.current;

    if (prev === null) {
      // First load — notify for any existing waiting items
      knownWaitingIds.current = currentWaitingIds;
      const existing = todos.filter((t) => t.status === "waiting");
      for (const todo of existing) {
        addToast(todo.text);
      }
      return;
    }

    const newWaiting = todos.filter(
      (t) => t.status === "waiting" && !prev.has(t.id)
    );

    knownWaitingIds.current = currentWaitingIds;

    if (newWaiting.length === 0) return;

    // In-app toast (always works)
    for (const todo of newWaiting) {
      addToast(todo.text);
    }

    // Browser notification (best-effort)
    if ("Notification" in window && Notification.permission === "granted") {
      for (const todo of newWaiting) {
        const body = todo.session_id
          ? `${todo.text}\n(session: ${todo.session_id.slice(0, 8)}…)`
          : todo.text;
        const n = new Notification("Todo Today", { body });
        n.onclick = () => { window.focus(); n.close(); };
      }
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
          const prefix = todo.run_status === "error" ? "Run failed" : "Run completed";
          addToast(`${prefix}: ${todo.text}`);
        }
      }
    }

    knownRunningIds.current = nowRunning;
  }, [addToast]);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getState();
      setState(data);
      notifyNewWaitingTodos(data.todos);
      notifyRunCompletions(data.todos);
      const waitingCount = data.todos.filter((t) => t.status === "waiting").length;
      document.title = waitingCount > 0 ? `(${waitingCount}) Todo Today` : "Todo Today";
    } catch (err) {
      console.error("Failed to fetch state:", err);
    }
  }, [notifyNewWaitingTodos, notifyRunCompletions]);

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
            <div key={t.id} className="toast">{t.text}</div>
          ))}
        </div>
      )}
      <aside className="sidebar">
        <h1 className="app-title">Todo Today</h1>
        <ClaudeStatus metadata={state.metadata} onRefresh={refresh} />
        <ProjectList
          projects={state.projects}
          selectedId={selectedProject}
          onSelect={selectProject}
          onRefresh={refresh}
        />
        <UpdateHistory history={state.metadata.history} />
      </aside>
      <main className="main">
        <TodoList
          todos={state.todos}
          projects={state.projects}
          selectedProjectId={selectedProject}
          projectSummaries={state.metadata.project_summaries}
          insights={state.metadata.insights}
          onRefresh={refresh}
        />
      </main>
    </div>
  );
}

export default App;
