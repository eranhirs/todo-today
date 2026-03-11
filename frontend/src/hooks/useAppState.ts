import { useCallback, useEffect, useRef, useState } from "react";
import type { FullState, Todo } from "../types";
import { api } from "../api";

const POLL_INTERVAL = 3_000;

interface UseAppStateOptions {
  notifyNewWaitingTodos: (todos: Todo[]) => void;
  notifyRunCompletions: (todos: Todo[]) => void;
  notifyHookEvents: () => void;
}

export function useAppState({
  notifyNewWaitingTodos,
  notifyRunCompletions,
  notifyHookEvents,
}: UseAppStateOptions) {
  const [state, setState] = useState<FullState | null>(null);

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

  const optimisticUpdate = useCallback(
    (fn: (todos: Todo[]) => Todo[]) =>
      setState((prev) => (prev ? { ...prev, todos: fn(prev.todos) } : prev)),
    []
  );

  // Request browser notification permission
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Poll for state
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
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
  };
}
