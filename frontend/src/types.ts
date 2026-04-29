export type TodoStatus = "next" | "in_progress" | "completed" | "consider" | "waiting" | "stale" | "rejected";

/** Sentinel selectedProject value for the "All Pinned Projects" view. */
export const PINNED_VIEW_ID = "__pinned__";

/** Single source of truth for whether a todo counts as "unread". */
export const isUnread = (t: Pick<Todo, "completed_by_run" | "is_read">): boolean =>
  t.completed_by_run && !t.is_read;

export interface Project {
  id: string;
  name: string;
  source_path: string;
  auto_run_quota: number;
  scheduled_auto_run_quota: number;
  autopilot_starts_at: string | null;
  todo_quota: number;
  run_model: string | null;  // null = use global setting
  pinned: boolean;
  created_at: string;
}

export interface Todo {
  id: string;
  project_id: string;
  text: string;
  status: TodoStatus;
  source: "claude" | "user";
  completed_by_run: boolean;
  emoji: string | null;
  session_id: string | null;
  source_session_id: string | null;
  parent_todo_id: string | null;  // Manually-set parent; takes precedence over source_session_id for parent resolution
  created_at: string;
  completed_at: string | null;
  rejected_at: string | null;
  original_text: string | null;
  run_output: string | null;
  run_status: "running" | "done" | "error" | "stopped" | "queued" | null;
  run_trigger: "manual" | "autopilot" | null;
  btw_output: string | null;
  btw_status: "running" | "done" | "error" | null;
  run_started_at: string | null;
  is_read: boolean;
  plan_only: boolean;
  plan_file: string | null;
  manual: boolean;
  is_command: boolean;
  priority: number | null;  // 1=critical, 2=high, 3=medium, 4=low, null=no priority
  sort_order: number;
  user_ordered: boolean;
  stale_reason: string | null;
  images: { filename: string; added_at: string; source: "creation" | "followup" }[];
  pending_followup: string | null;
  red_flags: { label: string; explanation: string; excerpt: string; resolved: boolean; resolved_at?: string; source?: "pattern" | "ai" }[];
  run_cost_usd: number | null;
  run_input_tokens: number | null;
  run_output_tokens: number | null;
  run_cache_read_tokens: number | null;
  run_duration_ms: number | null;
  run_context_tokens: number | null;  // last turn's input+cache_read — true current context size
  run_finished_at: string | null;  // ISO-8601: when the last run/follow-up finished
  run_after: string | null;  // ISO-8601: skip autopilot until this time
  pending_session_autopilot: number;  // Quota to activate as session_autopilot once todo runs
  autopilot: boolean;  // When True, analyzer-suggested follow-ups are auto-sent
  suggested_followup: string | null;  // Analyzer's next-message suggestion
  suggested_followup_at: string | null;  // ISO-8601: when suggestion was generated
  suggested_followup_sent: boolean;  // Whether the suggestion was auto-sent
}

export interface Insight {
  id: string;
  project_id: string;
  text: string;
  source_analysis_timestamp: string;
  dismissed: boolean;
  created_at: string;
}

export interface AnalysisEntry {
  timestamp: string;
  duration_seconds: number;
  sessions_analyzed: number;
  todos_added: number;
  todos_completed: number;
  todos_modified: number;
  summary: string;
  model: string;
  trigger: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  error: string | null;
  completed_todo_ids: string[];
  completed_todo_texts: string[];
  added_todos_active: string[];
  added_todos_completed: string[];
  modified_todos: string[];
  new_project_names: string[];
  insights: string[];
  prompt_length: number;
  prompt_text: string;
  claude_response: string;
  claude_reasoning: string;
}

export interface Settings {
  analysis_interval_minutes: number;
  analysis_model: string;
  run_model: string;
  heartbeat_enabled: boolean;
  hook_analysis_enabled: boolean;
  token_budget_usd: number;
}

export type SettingsUpdate = Partial<Settings>;

export interface Metadata {
  last_analysis: AnalysisEntry | null;
  history: AnalysisEntry[];
  scheduler_status: string;
  heartbeat: string;
  project_summaries: Record<string, string>;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_analyses: number;
  total_run_cost_usd: number;
  total_run_input_tokens: number;
  total_run_output_tokens: number;
  analysis_interval_minutes: number;
  analysis_model: string;
  insights: Insight[];
  heartbeat_enabled: boolean;
  hook_analysis_enabled: boolean;
}

export interface SessionInfo {
  key: string;
  project_dir: string;
  source_path: string;
  project_name: string;
  session_id: string;
  mtime: number;
  message_count: number;
  last_analyzed_mtime: number | null;
  state?: string;
  state_source?: string;
}

export interface FullState {
  projects: Project[];
  todos: Todo[];
  metadata: Metadata;
  settings: Settings;
  analysis_locked: boolean;
  autopilot_running: boolean;
  completed_total: number;
  has_more_completed: boolean;
  completed_by_project: Record<string, number>;
  unread_counts: Record<string, number>;  // {"_total": N, "<project_id>": N}
  session_autopilot: Record<string, number>;  // session_id → remaining quota
}

export interface CompletedPage {
  todos: Todo[];
  total: number;
  has_more: boolean;
}
