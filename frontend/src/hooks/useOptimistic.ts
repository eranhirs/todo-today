import { useCallback, useRef } from "react";
import type { FullState, Project, Todo } from "../types";

/**
 * Shared optimistic-update primitives used across the app.
 *
 * Manages ref-based override stores (so polling re-applies them),
 * pending creates, and pending deletes — and exposes high-level
 * helpers that encapsulate the full optimistic lifecycle:
 *   1. Register override (survives polling)
 *   2. Apply to local state immediately
 *   3. Await API call
 *   4. On success → clear override, refresh
 *   5. On failure → clear override, revert state, toast
 */

export interface OptimisticActions {
  /* ── Ref stores (used by useAppState for polling re-application) ── */
  overrides: React.RefObject<Map<string, Partial<Todo>>>;
  projectOverrides: React.RefObject<Map<string, Partial<Project>>>;
  pendingNewTodos: React.RefObject<Map<string, Todo>>;
  pendingDeleteIds: React.RefObject<Set<string>>;

  /* ── Low-level mutators ── */
  addOptimisticOverride: (id: string, fields: Partial<Todo>) => void;
  removeOptimisticOverride: (id: string) => void;
  addOptimisticProjectOverride: (id: string, fields: Partial<Project>) => void;
  removeOptimisticProjectOverride: (id: string) => void;
  addPendingNewTodo: (todo: Todo) => void;
  removePendingNewTodo: (id: string) => void;
  addPendingDelete: (id: string) => void;
  removePendingDelete: (id: string) => void;

  /* ── High-level helpers ── */

  /**
   * Optimistic todo field update with automatic override management.
   *
   * Registers an override, applies fields to local state, awaits the API call,
   * and cleans up — reverting on failure.
   */
  applyTodoUpdate: (opts: {
    todoId: string;
    fields: Partial<Todo>;
    apiCall: () => Promise<unknown>;
    revertFields: Partial<Todo>;
    setState: React.Dispatch<React.SetStateAction<FullState | null>>;
    onRefresh: () => void;
    onError?: string;
    addToast?: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  }) => Promise<void>;

  /**
   * Optimistic project field update with automatic override management.
   */
  applyProjectUpdate: (opts: {
    projectId: string;
    fields: Partial<Project>;
    apiCall: () => Promise<unknown>;
    setState: React.Dispatch<React.SetStateAction<FullState | null>>;
    onRefresh: () => void;
  }) => Promise<void>;
}

export function useOptimistic(): OptimisticActions {
  const overrides = useRef<Map<string, Partial<Todo>>>(new Map());
  const projectOverrides = useRef<Map<string, Partial<Project>>>(new Map());
  const pendingNewTodos = useRef<Map<string, Todo>>(new Map());
  const pendingDeleteIds = useRef<Set<string>>(new Set());

  // ── Low-level mutators ──

  const addOptimisticOverride = useCallback((id: string, fields: Partial<Todo>) => {
    overrides.current.set(id, { ...overrides.current.get(id), ...fields });
  }, []);

  const removeOptimisticOverride = useCallback((id: string) => {
    overrides.current.delete(id);
  }, []);

  const addOptimisticProjectOverride = useCallback((id: string, fields: Partial<Project>) => {
    projectOverrides.current.set(id, { ...projectOverrides.current.get(id), ...fields });
  }, []);

  const removeOptimisticProjectOverride = useCallback((id: string) => {
    projectOverrides.current.delete(id);
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

  // ── High-level helpers ──

  const applyTodoUpdate = useCallback(async ({
    todoId,
    fields,
    apiCall,
    revertFields,
    setState,
    onRefresh,
    onError,
    addToast,
  }: {
    todoId: string;
    fields: Partial<Todo>;
    apiCall: () => Promise<unknown>;
    revertFields: Partial<Todo>;
    setState: React.Dispatch<React.SetStateAction<FullState | null>>;
    onRefresh: () => void;
    onError?: string;
    addToast?: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  }) => {
    addOptimisticOverride(todoId, fields);
    setState((prev) => {
      if (!prev) return prev;
      return { ...prev, todos: prev.todos.map((t) => t.id === todoId ? { ...t, ...fields } : t) };
    });
    try {
      await apiCall();
      removeOptimisticOverride(todoId);
      onRefresh();
    } catch {
      removeOptimisticOverride(todoId);
      setState((prev) => {
        if (!prev) return prev;
        return { ...prev, todos: prev.todos.map((t) => t.id === todoId ? { ...t, ...revertFields } : t) };
      });
      if (onError && addToast) addToast(onError, "error");
    }
  }, [addOptimisticOverride, removeOptimisticOverride]);

  const applyProjectUpdate = useCallback(async ({
    projectId,
    fields,
    apiCall,
    setState,
    onRefresh,
  }: {
    projectId: string;
    fields: Partial<Project>;
    apiCall: () => Promise<unknown>;
    setState: React.Dispatch<React.SetStateAction<FullState | null>>;
    onRefresh: () => void;
  }) => {
    // Register override + apply to local state immediately
    addOptimisticProjectOverride(projectId, fields);
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        projects: prev.projects.map((p) => p.id === projectId ? { ...p, ...fields } : p),
      };
    });
    try {
      await apiCall();
    } finally {
      removeOptimisticProjectOverride(projectId);
      onRefresh();
    }
  }, [addOptimisticProjectOverride, removeOptimisticProjectOverride]);

  return {
    overrides,
    projectOverrides,
    pendingNewTodos,
    pendingDeleteIds,
    addOptimisticOverride,
    removeOptimisticOverride,
    addOptimisticProjectOverride,
    removeOptimisticProjectOverride,
    addPendingNewTodo,
    removePendingNewTodo,
    addPendingDelete,
    removePendingDelete,
    applyTodoUpdate,
    applyProjectUpdate,
  };
}
