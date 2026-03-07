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

type ToastType = "info" | "warning" | "success" | "error";

interface Toast {
  id: string;
  text: string;
  type: ToastType;
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
  const knownHookStates = useRef<Map<string, string>>(new Map());

  const addToast = useCallback((text: string, type: ToastType = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, text, type }]);
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
        addToast(todo.text, "warning");
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
      addToast(todo.text, "warning");
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

  const notifyHookEvents = useCallback(async () => {
    try {
      const events = await api.getHookEvents();
      const prev = knownHookStates.current;
      const next = new Map<string, string>();

      for (const [key, entry] of Object.entries(events)) {
        next.set(key, entry.state);
        const prevState = prev.get(key);
        if (prevState === entry.state) continue; // no change

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
          const n = new Notification(`Todo Today — ${project}`, { body: msg });
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
          if (todo.run_status === "error") {
            addToast(`Run failed: ${todo.text}`, "error");
          } else {
            addToast(`Run completed: ${todo.text}`, "success");
          }
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
      notifyHookEvents();
      const waitingCount = data.todos.filter((t) => t.status === "waiting").length;
      document.title = waitingCount > 0 ? `(${waitingCount}) Todo Today` : "Todo Today";
    } catch (err) {
      console.error("Failed to fetch state:", err);
    }
  }, [notifyNewWaitingTodos, notifyRunCompletions, notifyHookEvents]);

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
            <div key={t.id} className={`toast toast-${t.type}`}>{t.text}</div>
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
