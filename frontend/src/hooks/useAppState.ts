import { useCallback, useEffect, useRef, useState } from "react";
import type { FullState, Project, Todo } from "../types";
import { api, isStaticDemo } from "../api";
import { ApiError } from "../errors";

const POLL_INTERVAL = 3_000;
const COMPLETED_PAGE_SIZE = 50;

interface UseAppStateOptions {
  notifyNewWaitingTodos: (todos: Todo[]) => void;
  notifyRunCompletions: (todos: Todo[], projects: Project[]) => void;
  notifyHookEvents: () => void;
}

export function useAppState({
  notifyNewWaitingTodos,
  notifyRunCompletions,
  notifyHookEvents,
}: UseAppStateOptions) {
  const [state, setState] = useState<FullState | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  // Track how many completed todos we've loaded so far (for infinite scroll)
  const completedLoadedRef = useRef(COMPLETED_PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

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

  // Use a ref to always call the latest callbacks without re-creating the interval
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  refreshRef.current = async () => {
    try {
      const data = await api.getState();
      setIsOffline(false);

      // If user had loaded more completed todos, reload those extra pages too
      const extraLoaded = completedLoadedRef.current;
      if (extraLoaded > COMPLETED_PAGE_SIZE && data.has_more_completed) {
        try {
          const extra = await api.loadMoreCompleted(COMPLETED_PAGE_SIZE, extraLoaded - COMPLETED_PAGE_SIZE);
          if (extra.todos.length > 0) {
            const existingIds = new Set(data.todos.map((t) => t.id));
            const newTodos = extra.todos.filter((t) => !existingIds.has(t.id));
            data.todos = [...data.todos, ...newTodos];
            data.has_more_completed = extra.has_more;
            data.completed_total = extra.total;
          }
        } catch { /* ignore — base state is still valid */ }
      }

      setState(data);
      notifyNewWaitingTodos(data.todos);
      notifyRunCompletions(data.todos, data.projects);
      notifyHookEvents();
      const waitingCount = data.todos.filter((t) => t.status === "waiting").length;
      document.title = waitingCount > 0 ? `(${waitingCount}) Claude Todos` : "Claude Todos";
    } catch (err) {
      if (err instanceof ApiError && err.isNetwork) {
        setIsOffline(true);
        console.warn("Failed to fetch state: server unreachable");
      } else {
        console.error("Failed to fetch state:", err);
      }
    }
  };

  const refresh = useCallback(async () => {
    await refreshRef.current?.();
  }, []);

  const optimisticUpdate = useCallback(
    (fn: (todos: Todo[]) => Todo[]) =>
      setState((prev) => (prev ? { ...prev, todos: fn(prev.todos) } : prev)),
    []
  );

  // Load more completed todos (for infinite scroll)
  const loadMoreCompleted = useCallback(async (projectId?: string | null) => {
    if (loadingMore || !state?.has_more_completed) return;
    setLoadingMore(true);
    try {
      const offset = completedLoadedRef.current;
      const data = await api.loadMoreCompleted(offset, COMPLETED_PAGE_SIZE, projectId || undefined);
      if (data.todos.length > 0) {
        completedLoadedRef.current = offset + data.todos.length;
        setState((prev) => {
          if (!prev) return prev;
          // Merge new completed todos, deduplicating by id
          const existingIds = new Set(prev.todos.map((t) => t.id));
          const newTodos = data.todos.filter((t) => !existingIds.has(t.id));
          return {
            ...prev,
            todos: [...prev.todos, ...newTodos],
            has_more_completed: data.has_more,
            completed_total: data.total,
          };
        });
      }
    } catch (err) {
      console.error("Failed to load more completed todos:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, state?.has_more_completed]);

  // Request browser notification permission
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Poll for state (disabled in static demo — single fetch is enough).
  // Pause polling when the tab is hidden to prevent accumulated callbacks
  // from firing all at once when the user returns, which freezes the UI.
  useEffect(() => {
    refresh();
    if (isStaticDemo) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (!intervalId) {
        intervalId = setInterval(refresh, POLL_INTERVAL);
      }
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        // Single immediate refresh, then resume normal polling
        refresh();
        startPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  return {
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
  };
}
