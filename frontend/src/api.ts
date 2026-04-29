import type { CompletedPage, FullState, Project, SessionInfo, Settings, SettingsUpdate, Todo, TodoStatus } from "./types";
import { ApiError } from "./errors";

// In demo mode, BASE_URL is set via DEMO_BASE_URL — derive API path from it
// so requests stay on the same HTTPS origin and get proxied by Apache.
const BASE = import.meta.env.VITE_API_URL || `${import.meta.env.BASE_URL}api`.replace(/\/\/+/g, "/");

/** Static demo mode: state is embedded in the HTML, no backend needed */
const _w = window as unknown as { __DEMO_STATE__?: FullState };
export const isStaticDemo = !!_w.__DEMO_STATE__;

/** ETag tracking for /api/state — enables 304 Not Modified responses */
let _stateETag: string | null = null;

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
  /** Fetch full state with ETag support. Returns null on 304 (no changes). */
  getState: async (): Promise<FullState | null> => {
    if (isStaticDemo) return _w.__DEMO_STATE__!;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (_stateETag) headers["If-None-Match"] = _stateETag;
    let res: Response;
    try {
      res = await fetch(`${BASE}/state`, { headers });
    } catch (err) {
      throw ApiError.networkError(err);
    }
    if (res.status === 304) return null; // no changes since last fetch
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      let errorCode: string | null = null;
      try {
        const body = await res.json();
        if (body.detail) detail = body.detail;
        if (body.error_code) errorCode = body.error_code;
      } catch { /* ignore */ }
      throw ApiError.fromResponse(res.status, detail, errorCode);
    }
    _stateETag = res.headers.get("ETag");
    return res.json();
  },

  loadMoreCompleted: (offset: number, limit = 50, projectId?: string): Promise<CompletedPage> =>
    request<CompletedPage>(`/todos/completed?offset=${offset}&limit=${limit}${projectId ? `&project_id=${projectId}` : ""}`),

  searchTodos: (q: string, projectId?: string): Promise<Todo[]> =>
    request<Todo[]>(`/todos/search?q=${encodeURIComponent(q)}${projectId ? `&project_id=${projectId}` : ""}`),

  getTodo: (id: string): Promise<Todo> =>
    request<Todo>(`/todos/${encodeURIComponent(id)}`),

  createProject: (name: string, source_path = "") =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, source_path }),
    }),

  deleteProject: (id: string) =>
    request<void>(`/projects/${id}`, { method: "DELETE" }),

  getTags: () => request<string[]>("/todos/tags"),

  getCommands: (projectId?: string) => request<{ name: string; description: string; type: "command" | "skill" }[]>(`/todos/commands${projectId ? `?project_id=${projectId}` : ""}`),

  renameTag: (oldTag: string, newTag: string) =>
    request<{ status: string; updated: number }>("/todos/tags/rename", {
      method: "PUT",
      body: JSON.stringify({ old_tag: oldTag, new_tag: newTag }),
    }),

  createTodo: (project_id: string, text: string, plan_only = false, images: string[] = []) =>
    request<Todo>("/todos", {
      method: "POST",
      body: JSON.stringify({ project_id, text, plan_only, images }),
    }),

  uploadImage: async (file: File): Promise<{ filename: string }> => {
    const formData = new FormData();
    formData.append("file", file);
    let res: Response;
    try {
      res = await fetch(`${BASE}/todos/images`, {
        method: "POST",
        body: formData,
      });
    } catch (err) {
      throw ApiError.networkError(err);
    }
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body.detail) detail = body.detail;
      } catch { /* ignore */ }
      throw ApiError.fromResponse(res.status, detail, null);
    }
    return res.json();
  },

  imageUrl: (filename: string): string => `${BASE}/todos/images/${filename}`,

  deleteImage: (filename: string) =>
    request<void>(`/todos/images/${filename}`, { method: "DELETE" }),

  updateTodo: (id: string, data: { text?: string; status?: TodoStatus; project_id?: string; source?: "claude" | "user"; user_ordered?: boolean; is_read?: boolean; parent_todo_id?: string; autopilot?: boolean }) =>
    request<Todo>(`/todos/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteTodo: (id: string) =>
    request<void>(`/todos/${id}`, { method: "DELETE" }),

  resolveRedFlag: (todoId: string, flagIndex: number, resolved: boolean) =>
    request<Todo>(`/todos/${todoId}/red_flags/${flagIndex}`, {
      method: "PUT",
      body: JSON.stringify({ flag_index: flagIndex, resolved }),
    }),

  dismissRedFlag: (todoId: string, flagIndex: number) =>
    request<Todo>(`/todos/${todoId}/red_flags/${flagIndex}`, {
      method: "DELETE",
    }),

  reorderTodos: (todoIds: string[], movedId?: string) =>
    request<{ status: string }>("/todos/reorder", {
      method: "PUT",
      body: JSON.stringify({ todo_ids: todoIds, moved_id: movedId }),
    }),

  runTodo: (id: string, planOnly?: boolean) =>
    request<{ status: string }>(`/todos/${id}/run`, {
      method: "POST",
      body: planOnly !== undefined ? JSON.stringify({ plan_only: planOnly }) : undefined,
    }),

  stopTodo: (id: string) =>
    request<{ status: string }>(`/todos/${id}/stop`, { method: "POST" }),

  dequeueTodo: (id: string) =>
    request<{ status: string }>(`/todos/${id}/dequeue`, { method: "POST" }),

  runTodoNow: (id: string) =>
    request<{ status: string }>(`/todos/${id}/run-now`, { method: "POST" }),

  followupTodo: (id: string, message: string, images: string[] = [], planOnly?: boolean) =>
    request<{ status: string }>(`/todos/${id}/followup`, {
      method: "POST",
      body: JSON.stringify({ message, images, ...(planOnly !== undefined && { plan_only: planOnly }) }),
    }),

  editFollowup: (id: string, message: string) =>
    request<{ status: string }>(`/todos/${id}/followup`, {
      method: "PATCH",
      body: JSON.stringify({ message }),
    }),

  cancelFollowup: (id: string) =>
    request<{ status: string }>(`/todos/${id}/followup`, { method: "DELETE" }),

  btwTodo: (id: string, message: string) =>
    request<{ status: string }>(`/todos/${id}/btw`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  setSessionAutopilot: (id: string, quota: number) =>
    request<{ status: string; session_id: string; quota: number }>(`/todos/${id}/session-autopilot`, {
      method: "POST",
      body: JSON.stringify({ quota }),
    }),

  setAutopilot: (id: string, enabled: boolean) =>
    request<{ status: string; autopilot: boolean }>(`/todos/${id}/autopilot`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),

  dismissSuggestedFollowup: (id: string) =>
    request<{ status: string }>(`/todos/${id}/suggested-followup`, { method: "DELETE" }),

  scheduleTodo: (id: string, runAfter: string | null) =>
    request<{ status: string; todo_id: string; run_after: string | null }>(`/todos/${id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ run_after: runAfter }),
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

  dismissHookEvent: (sessionKey: string) =>
    request<{ status: string; session_key: string }>("/claude/hooks/events/dismiss", {
      method: "POST",
      body: JSON.stringify({ session_key: sessionKey }),
    }),

  getHookLog: (limit = 100) =>
    request<{ ts: string; session_key: string; hook_event: string; state: string | null; project_name: string | null; detail: string | null }[]>(`/claude/hooks/log?limit=${limit}`),

  getHooksStatus: () =>
    request<{ installed: boolean; installed_events: string[]; hook_script: string }>("/claude/hooks/status"),

  installHooks: () =>
    request<{ status: string; installed_events: string[]; added_permissions: string[] }>("/claude/hooks/install", {
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

  updateProject: (id: string, data: { name?: string; source_path?: string; auto_run_quota?: number; scheduled_auto_run_quota?: number; autopilot_starts_at?: string; clear_scheduled_autopilot?: boolean; todo_quota?: number; run_model?: string; clear_run_model?: boolean; pinned?: boolean }) =>
    request<Project>(`/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  getRecentEvents: (limit = 50) =>
    request<{ type: string; data: Record<string, unknown>; ts: number }[]>(`/events/recent?limit=${limit}`),

  getEventBusStatus: () =>
    request<{ subscribers: number; recent_events: number }>("/events/status"),

  getClaudeUsage: () =>
    request<ClaudeUsageResponse>("/claude/usage"),
};

export interface ClaudeUsageLimit {
  utilization: number | null;
  resets_at: string | null;
}

export interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageLimit | null;
  seven_day?: ClaudeUsageLimit | null;
  seven_day_sonnet?: ClaudeUsageLimit | null;
  seven_day_opus?: ClaudeUsageLimit | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
  error?: string;
}
