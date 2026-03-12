import type { FullState, Project, SessionInfo, Settings, SettingsUpdate, Todo, TodoStatus } from "./types";
import { ApiError } from "./errors";

const BASE = "/api";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
  } catch (err) {
    throw ApiError.networkError(err);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    let errorCode: string | null = null;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
      if (body.error_code) errorCode = body.error_code;
    } catch { /* ignore parse errors */ }
    throw ApiError.fromResponse(res.status, detail, errorCode);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getState: () => request<FullState>("/state"),

  createProject: (name: string, source_path = "") =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, source_path }),
    }),

  deleteProject: (id: string) =>
    request<void>(`/projects/${id}`, { method: "DELETE" }),

  getTags: () => request<string[]>("/todos/tags"),

  createTodo: (project_id: string, text: string) =>
    request<Todo>("/todos", {
      method: "POST",
      body: JSON.stringify({ project_id, text }),
    }),

  updateTodo: (id: string, data: { text?: string; status?: TodoStatus; project_id?: string; source?: "claude" | "user"; user_ordered?: boolean }) =>
    request<Todo>(`/todos/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteTodo: (id: string) =>
    request<void>(`/todos/${id}`, { method: "DELETE" }),

  reorderTodos: (todoIds: string[], movedId?: string) =>
    request<{ status: string }>("/todos/reorder", {
      method: "PUT",
      body: JSON.stringify({ todo_ids: todoIds, moved_id: movedId }),
    }),

  runTodo: (id: string) =>
    request<{ status: string }>(`/todos/${id}/run`, { method: "POST" }),

  stopTodo: (id: string) =>
    request<{ status: string }>(`/todos/${id}/stop`, { method: "POST" }),

  dequeueTodo: (id: string) =>
    request<{ status: string }>(`/todos/${id}/dequeue`, { method: "POST" }),

  followupTodo: (id: string, message: string) =>
    request<{ status: string }>(`/todos/${id}/followup`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  wakeUpClaude: (model?: string, force?: boolean, sessionKeys?: string[]) =>
    request<{ status: string; message?: string }>("/claude/wake", {
      method: "POST",
      body: JSON.stringify({
        ...(model ? { model } : {}),
        ...(force ? { force } : {}),
        ...(sessionKeys ? { session_keys: sessionKeys } : {}),
      }),
    }),

  getSessions: () => request<SessionInfo[]>("/claude/sessions"),

  getSettings: () => request<Settings>("/claude/settings"),

  updateSettings: (update: SettingsUpdate) =>
    request<Settings>("/claude/settings", {
      method: "PUT",
      body: JSON.stringify(update),
    }),

  setAnalysisInterval: (minutes: number) =>
    request<{ minutes: number }>("/claude/interval", {
      method: "PUT",
      body: JSON.stringify({ minutes }),
    }),

  setAnalysisModel: (model: string) =>
    request<{ model: string }>("/claude/model", {
      method: "PUT",
      body: JSON.stringify({ model }),
    }),

  dismissInsight: (id: string) =>
    request<{ status: string }>(`/claude/insights/${id}/dismiss`, {
      method: "PUT",
    }),

  getHookEvents: () =>
    request<Record<string, { state: string; tool_name?: string; detail?: string; project_name?: string; timestamp: string; hook_event: string }>>("/claude/hooks/events"),

  getHookLog: (limit = 100) =>
    request<{ ts: string; session_key: string; hook_event: string; state: string | null; project_name: string | null; detail: string | null }[]>(`/claude/hooks/log?limit=${limit}`),

  getHooksStatus: () =>
    request<{ installed: boolean; installed_events: string[]; hook_script: string }>("/claude/hooks/status"),

  installHooks: () =>
    request<{ status: string; installed_events: string[] }>("/claude/hooks/install", {
      method: "POST",
    }),

  uninstallHooks: () =>
    request<{ status: string; removed_events: string[] }>("/claude/hooks/uninstall", {
      method: "POST",
    }),

  setHeartbeatEnabled: (enabled: boolean) =>
    request<{ heartbeat_enabled: boolean }>("/claude/heartbeat/enabled", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  setHookAnalysisEnabled: (enabled: boolean) =>
    request<{ hook_analysis_enabled: boolean }>("/claude/hook-analysis/enabled", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  updateProject: (id: string, data: { name?: string; source_path?: string; auto_run_quota?: number }) =>
    request<Project>(`/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  getRecentEvents: (limit = 50) =>
    request<{ type: string; data: Record<string, unknown>; ts: number }[]>(`/events/recent?limit=${limit}`),

  getEventBusStatus: () =>
    request<{ subscribers: number; recent_events: number }>("/events/status"),
};
