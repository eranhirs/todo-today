import { useCallback, useEffect, useRef, useState } from "react";
import type { FullState, Project, Todo } from "../types";
import { api, isStaticDemo } from "../api";
import { ApiError } from "../errors";

// Slow fallback poll — SSE events drive real-time updates, this is just a safety net
const POLL_INTERVAL = 30_000;
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
  // IDs of todos pending deletion (undo window active) — polling should hide these
  const pendingDeleteIds = useRef<Set<string>>(new Set());
  // In-flight optimistic field overrides — re-applied on top of polled data so
  // polling doesn't flash stale values before the API call resolves.
  const optimisticOverrides = useRef<Map<string, Partial<Todo>>>(new Map());
  // Optimistic placeholder todos for in-flight creates — re-prepended on refresh
  // so they don't vanish while the API call is still in progress.
  const pendingNewTodos = useRef<Map<string, Todo>>(new Map());
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

      // 304 Not Modified — nothing changed, skip all processing
      if (data === null) return;

      // If user had loaded more completed todos (global), reload those extra pages too
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

      // Filter out todos that are pending deletion (undo window still open)
      const pendingIds = pendingDeleteIds.current;
      if (pendingIds.size > 0) {
        data.todos = data.todos.filter((t) => !pendingIds.has(t.id));
      }

      // Re-apply in-flight optimistic overrides so polling doesn't flash stale values
      const overrides = optimisticOverrides.current;
      if (overrides.size > 0) {
        data.todos = data.todos.map((t) => {
          const ov = overrides.get(t.id);
          return ov ? { ...t, ...ov } : t;
        });
      }

      // Re-prepend in-flight optimistic new todos so they don't vanish during create
      const pending = pendingNewTodos.current;
      if (pending.size > 0) {
        const serverIds = new Set(data.todos.map((t) => t.id));
        const stillPending = [...pending.values()].filter((t) => !serverIds.has(t.id));
        if (stillPending.length > 0) {
          data.todos = [...stillPending, ...data.todos];
        }
      }

      // Use functional setState to preserve any extra completed todos loaded
      // via project-specific pagination that aren't covered by the global re-fetch above.
      // Without this, polling overwrites state and drops project-specific extras.
      setState((prev) => {
        if (!prev) return data;
        const freshIds = new Set(data.todos.map((t) => t.id));
        const extraProjectCompleted = prev.todos.filter(
          (t) => t.status === "completed" && !freshIds.has(t.id)
        );
        if (extraProjectCompleted.length > 0) {
          return {
            ...data,
            todos: [...data.todos, ...extraProjectCompleted],
          };
        }
        return data;
      });
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

  const addOptimisticOverride = useCallback((id: string, fields: Partial<Todo>) => {
    optimisticOverrides.current.set(id, { ...optimisticOverrides.current.get(id), ...fields });
  }, []);

  const removeOptimisticOverride = useCallback((id: string) => {
    optimisticOverrides.current.delete(id);
  }, []);

  const addPendingNewTodo = useCallback((todo: Todo) => {
    pendingNewTodos.current.set(todo.id, todo);
  }, []);

  const removePendingNewTodo = useCallback((id: string) => {
    pendingNewTodos.current.delete(id);
  }, []);

  const addPendingDelete = useCallback((id: string) => {
    pendingDeleteIds.current.add(id);
  }, []);

  const removePendingDelete = useCallback((id: string) => {
    pendingDeleteIds.current.delete(id);
  }, []);

  // Load more completed todos (for infinite scroll)
  const loadMoreCompleted = useCallback(async (projectId?: string | null) => {
    if (loadingMore) return;
    // For project-specific loads, check if that project has more; for global, check global flag
    if (projectId) {
      const projTotal = state?.completed_by_project?.[projectId] ?? 0;
      const projLoaded = state?.todos.filter(t => t.project_id === projectId && t.status === "completed").length ?? 0;
      if (projLoaded >= projTotal) return;
    } else {
      if (!state?.has_more_completed) return;
    }
    setLoadingMore(true);
    try {
      // For project-specific loads, offset is how many of THAT project's completed are already loaded
      const offset = projectId
        ? (state?.todos.filter(t => t.project_id === projectId && t.status === "completed").length ?? 0)
        : completedLoadedRef.current;
      const data = await api.loadMoreCompleted(offset, COMPLETED_PAGE_SIZE, projectId || undefined);
      if (data.todos.length > 0) {
        if (!projectId) {
          completedLoadedRef.current = offset + data.todos.length;
        }
        setState((prev) => {
          if (!prev) return prev;
          // Merge new completed todos, deduplicating by id
          const existingIds = new Set(prev.todos.map((t) => t.id));
          const newTodos = data.todos.filter((t) => !existingIds.has(t.id));
          const updated: typeof prev = {
            ...prev,
            todos: [...prev.todos, ...newTodos],
            has_more_completed: projectId ? prev.has_more_completed : data.has_more,
            completed_total: projectId ? prev.completed_total : data.total,
          };
          if (projectId) {
            updated.completed_by_project = { ...prev.completed_by_project, [projectId]: data.total };
          }
          return updated;
        });
      }
    } catch (err) {
      console.error("Failed to load more completed todos:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, state?.has_more_completed, state?.completed_by_project, state?.todos]);

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
    addPendingDelete,
    removePendingDelete,
    addOptimisticOverride,
    removeOptimisticOverride,
    addPendingNewTodo,
    removePendingNewTodo,
  };
}
