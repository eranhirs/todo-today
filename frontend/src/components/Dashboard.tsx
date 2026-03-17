import React from "react";
import type { AnalysisEntry, Project, Todo } from "../types";
import { getDisplayName } from "../utils/displayNames";

interface Props {
  todos: Todo[];
  projects: Project[];
  projectSummaries: Record<string, string>;
  history: AnalysisEntry[];
  onSelectProject: (id: string) => void;
  completedTotal?: number;
}

const STATUS_COLORS: Record<string, string> = {
  next: "var(--text-dim)",
  in_progress: "var(--blue)",
  completed: "var(--green)",
  consider: "#636e88",
  waiting: "var(--amber)",
  stale: "var(--red)",
  rejected: "#8b5cf6",
};

const STATUS_LABELS: Record<string, string> = {
  next: "Next",
  in_progress: "In Progress",
  completed: "Done",
  consider: "Consider",
  waiting: "Waiting",
  stale: "Stale",
  rejected: "Rejected",
};

function statusCounts(todos: Todo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of todos) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }
  return counts;
}

function ProgressRing({ completed, total, size = 56 }: { completed: number; total: number; size?: number }) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = total === 0 ? 0 : completed / total;
  const offset = circumference * (1 - pct);

  return (
    <svg width={size} height={size} className="progress-ring">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--green)"
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--text)"
        fontSize="0.8rem"
        fontWeight="600"
      >
        {total === 0 ? "–" : `${Math.round(pct * 100)}%`}
      </text>
    </svg>
  );
}

function StatusBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  if (total === 0) return <div className="dash-status-bar empty-bar" />;
  const order = ["waiting", "in_progress", "next", "consider", "stale", "rejected", "completed"];
  return (
    <div className="dash-status-bar">
      {order.map((s) => {
        const n = counts[s] || 0;
        if (n === 0) return null;
        return (
          <div
            key={s}
            className="dash-status-segment"
            style={{
              width: `${(n / total) * 100}%`,
              background: STATUS_COLORS[s],
            }}
            title={`${STATUS_LABELS[s]}: ${n}`}
          />
        );
      })}
    </div>
  );
}

function buildActivityData(todos: Todo[], days: number) {
  const now = new Date();
  const buckets: { label: string; added: number; completed: number }[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString([], { weekday: "short", day: "numeric" });

    const added = todos.filter((t) => t.created_at.slice(0, 10) === key).length;
    const completed = todos.filter(
      (t) => t.completed_at && t.completed_at.slice(0, 10) === key
    ).length;

    buckets.push({ label, added, completed });
  }

  return buckets;
}

type WorkloadPeriod = "all" | "30d" | "7d";

function ProjectWorkload({ todos, projects }: { todos: Todo[]; projects: Project[] }) {
  const [period, setPeriod] = React.useState<WorkloadPeriod>("all");

  const now = Date.now();
  const cutoff =
    period === "7d" ? now - 7 * 86400_000 :
    period === "30d" ? now - 30 * 86400_000 :
    0;

  const projectStats = projects.map((proj) => {
    const projTodos = todos.filter((t) => t.project_id === proj.id);

    // Filter by period: count todos created OR completed within the window
    const periodTodos = cutoff === 0
      ? projTodos
      : projTodos.filter((t) => {
          const created = new Date(t.created_at).getTime();
          const completed = t.completed_at ? new Date(t.completed_at).getTime() : 0;
          return created >= cutoff || completed >= cutoff;
        });

    const total = periodTodos.length;
    const completed = periodTodos.filter((t) => t.status === "completed").length;
    const active = total - completed;

    // Average completion time (for todos completed in the period)
    const completedTodos = periodTodos.filter((t) => t.status === "completed" && t.completed_at);
    let avgCompletionHrs: number | null = null;
    if (completedTodos.length > 0) {
      const totalMs = completedTodos.reduce((sum, t) => {
        const created = new Date(t.created_at).getTime();
        const done = new Date(t.completed_at!).getTime();
        return sum + Math.max(0, done - created);
      }, 0);
      avgCompletionHrs = totalMs / completedTodos.length / 3600_000;
    }

    return { proj, total, completed, active, avgCompletionHrs };
  });

  // Sort by total descending
  const sorted = [...projectStats].sort((a, b) => b.total - a.total);
  const maxTotal = Math.max(1, ...sorted.map((s) => s.total));

  // Only show projects with activity
  const withActivity = sorted.filter((s) => s.total > 0);
  if (withActivity.length === 0) return null;

  return (
    <div className="dash-section">
      <div className="dash-workload-header">
        <h3 className="dash-section-title">Project Workload</h3>
        <div className="dash-period-toggle">
          {(["all", "30d", "7d"] as WorkloadPeriod[]).map((p) => (
            <button
              key={p}
              className={`dash-period-btn ${period === p ? "active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "all" ? "All Time" : p === "30d" ? "30 Days" : "7 Days"}
            </button>
          ))}
        </div>
      </div>
      <div className="dash-workload-list">
        {withActivity.map(({ proj, total, completed, active, avgCompletionHrs }) => {
          const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
          return (
            <div key={proj.id} className="dash-workload-row">
              <span className="dash-workload-name" title={getDisplayName(proj.id) ?? proj.name}>{getDisplayName(proj.id) ?? proj.name}</span>
              <div className="dash-workload-bar-wrap">
                <div className="dash-workload-bar-track">
                  <div
                    className="dash-workload-bar-fill completed"
                    style={{ width: `${(completed / maxTotal) * 100}%` }}
                    title={`${completed} completed`}
                  />
                  <div
                    className="dash-workload-bar-fill active-fill"
                    style={{ width: `${(active / maxTotal) * 100}%` }}
                    title={`${active} active`}
                  />
                </div>
              </div>
              <div className="dash-workload-stats">
                <span className="dash-workload-total">{total}</span>
                <span className="dash-workload-pct">{pct}%</span>
                {avgCompletionHrs !== null && (
                  <span className="dash-workload-avg" title="Avg completion time">
                    {avgCompletionHrs < 1
                      ? `${Math.round(avgCompletionHrs * 60)}m`
                      : avgCompletionHrs < 24
                        ? `${avgCompletionHrs.toFixed(1)}h`
                        : `${(avgCompletionHrs / 24).toFixed(1)}d`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="dash-workload-legend">
        <span className="dash-legend-item">
          <span className="dash-legend-dot" style={{ background: "var(--green)" }} />
          Completed
        </span>
        <span className="dash-legend-item">
          <span className="dash-legend-dot" style={{ background: "var(--accent)" }} />
          Active
        </span>
        <span className="dash-workload-legend-hint">
          % = completion rate &middot; time = avg to complete
        </span>
      </div>
    </div>
  );
}

export function Dashboard({ todos, projects, projectSummaries, history, onSelectProject, completedTotal = 0 }: Props) {
  const allCounts = statusCounts(todos);
  // Use the true completed total from backend (todos array is capped)
  const completedCount = completedTotal || allCounts["completed"] || 0;
  const totalTodos = (todos.length - (allCounts["completed"] || 0)) + completedCount;
  const activeCount = totalTodos - completedCount;
  const completionRate = totalTodos === 0 ? 0 : Math.round((completedCount / totalTodos) * 100);

  // Activity data for last 14 days
  const activity = buildActivityData(todos, 14);
  const maxActivity = Math.max(1, ...activity.map((d) => Math.max(d.added, d.completed)));

  // Recent analyses cost
  const last7dCost = history
    .filter((h) => {
      const d = new Date(h.timestamp);
      const now = new Date();
      return now.getTime() - d.getTime() < 7 * 86400 * 1000;
    })
    .reduce((sum, h) => sum + h.cost_usd, 0);

  if (totalTodos === 0 && projects.length === 0) {
    return (
      <div className="dashboard">
        <h2>Dashboard</h2>
        <div className="empty-state empty-state-large">
          <div className="empty-state-icon">📊</div>
          <p className="empty-state-title">Nothing here yet</p>
          <p className="empty-state-hint">
            Create a project and add some todos to see your dashboard come to life with charts, metrics, and progress tracking.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <h2>Dashboard</h2>

      {/* Summary metrics */}
      <div className="dash-metrics">
        <div className="dash-metric">
          <span className="dash-metric-value">{activeCount}</span>
          <span className="dash-metric-label">Active</span>
        </div>
        <div className="dash-metric">
          <span className="dash-metric-value">{completedCount}</span>
          <span className="dash-metric-label">Completed</span>
        </div>
        <div className="dash-metric">
          <span className="dash-metric-value">{completionRate}%</span>
          <span className="dash-metric-label">Completion</span>
        </div>
        <div className="dash-metric">
          <span className="dash-metric-value">{projects.length}</span>
          <span className="dash-metric-label">Projects</span>
        </div>
        <div className="dash-metric">
          <span className="dash-metric-value">${last7dCost.toFixed(2)}</span>
          <span className="dash-metric-label">7d Cost</span>
        </div>
      </div>

      {/* Overall status distribution */}
      <div className="dash-section">
        <h3 className="dash-section-title">Status Distribution</h3>
        <StatusBar counts={allCounts} total={totalTodos} />
        <div className="dash-status-legend">
          {["waiting", "in_progress", "next", "consider", "stale", "rejected", "completed"].map((s) => {
            const n = allCounts[s] || 0;
            if (n === 0) return null;
            return (
              <span key={s} className="dash-legend-item">
                <span className="dash-legend-dot" style={{ background: STATUS_COLORS[s] }} />
                {STATUS_LABELS[s]} ({n})
              </span>
            );
          })}
        </div>
      </div>

      {/* Activity chart */}
      <div className="dash-section">
        <h3 className="dash-section-title">Activity — Last 14 Days</h3>
        <div className="dash-activity-chart">
          {activity.map((day, i) => (
            <div key={i} className="dash-activity-day">
              <div className="dash-activity-bars">
                <div
                  className="dash-activity-bar bar-completed"
                  style={{ height: `${(day.completed / maxActivity) * 100}%` }}
                  title={`${day.completed} completed`}
                />
                <div
                  className="dash-activity-bar bar-added"
                  style={{ height: `${(day.added / maxActivity) * 100}%` }}
                  title={`${day.added} added`}
                />
              </div>
              <span className="dash-activity-label">{day.label}</span>
            </div>
          ))}
        </div>
        <div className="dash-activity-legend">
          <span className="dash-legend-item">
            <span className="dash-legend-dot" style={{ background: "var(--green)" }} />
            Completed
          </span>
          <span className="dash-legend-item">
            <span className="dash-legend-dot" style={{ background: "var(--accent)" }} />
            Added
          </span>
        </div>
      </div>

      {/* Project workload ranking */}
      {projects.length > 1 && (
        <ProjectWorkload todos={todos} projects={projects} />
      )}

      {/* Red Flag Analysis */}
      {(() => {
        const allFlags = todos.flatMap((t) => t.red_flags || []);
        if (allFlags.length === 0) return null;
        const totalFlags = allFlags.length;
        const resolvedFlags = allFlags.filter((f) => f.resolved).length;
        const unresolvedFlags = totalFlags - resolvedFlags;
        const todosWithFlags = todos.filter((t) => t.red_flags && t.red_flags.length > 0).length;
        const resolveRate = totalFlags === 0 ? 0 : Math.round((resolvedFlags / totalFlags) * 100);
        const flagRatio = totalTodos === 0 ? 0 : (todosWithFlags / totalTodos * 100);

        // Distribution by type
        const typeCounts: Record<string, { total: number; resolved: number }> = {};
        for (const f of allFlags) {
          if (!typeCounts[f.label]) typeCounts[f.label] = { total: 0, resolved: 0 };
          typeCounts[f.label].total++;
          if (f.resolved) typeCounts[f.label].resolved++;
        }
        const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1].total - a[1].total);
        const maxTypeCount = Math.max(1, ...sortedTypes.map(([, v]) => v.total));

        return (
          <div className="dash-section">
            <h3 className="dash-section-title">Red Flag Analysis</h3>
            <div className="dash-metrics">
              <div className="dash-metric">
                <span className="dash-metric-value" style={{ color: unresolvedFlags > 0 ? "#ff4d4d" : "var(--green)" }}>{unresolvedFlags}</span>
                <span className="dash-metric-label">Unresolved</span>
              </div>
              <div className="dash-metric">
                <span className="dash-metric-value" style={{ color: "var(--green)" }}>{resolvedFlags}</span>
                <span className="dash-metric-label">Resolved</span>
              </div>
              <div className="dash-metric">
                <span className="dash-metric-value">{resolveRate}%</span>
                <span className="dash-metric-label">Resolve Rate</span>
              </div>
              <div className="dash-metric">
                <span className="dash-metric-value">{flagRatio.toFixed(0)}%</span>
                <span className="dash-metric-label">Todos Flagged</span>
              </div>
              <div className="dash-metric">
                <span className="dash-metric-value">{totalFlags}</span>
                <span className="dash-metric-label">Total Flags</span>
              </div>
            </div>

            {/* Flag type distribution */}
            <div className="dash-workload-list" style={{ marginTop: "12px" }}>
              {sortedTypes.map(([label, counts]) => {
                const pct = counts.total === 0 ? 0 : Math.round((counts.resolved / counts.total) * 100);
                return (
                  <div key={label} className="dash-workload-row">
                    <span className="dash-workload-name" title={label}>{label}</span>
                    <div className="dash-workload-bar-wrap">
                      <div className="dash-workload-bar-track">
                        <div
                          className="dash-workload-bar-fill completed"
                          style={{ width: `${(counts.resolved / maxTypeCount) * 100}%` }}
                          title={`${counts.resolved} resolved`}
                        />
                        <div
                          className="dash-workload-bar-fill active-fill"
                          style={{ width: `${((counts.total - counts.resolved) / maxTypeCount) * 100}%`, background: "#ff4d4d" }}
                          title={`${counts.total - counts.resolved} unresolved`}
                        />
                      </div>
                    </div>
                    <div className="dash-workload-stats">
                      <span className="dash-workload-total">{counts.total}</span>
                      <span className="dash-workload-pct">{pct}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="dash-workload-legend">
              <span className="dash-legend-item">
                <span className="dash-legend-dot" style={{ background: "var(--green)" }} />
                Resolved
              </span>
              <span className="dash-legend-item">
                <span className="dash-legend-dot" style={{ background: "#ff4d4d" }} />
                Unresolved
              </span>
              <span className="dash-workload-legend-hint">
                % = resolve rate
              </span>
            </div>
          </div>
        );
      })()}

      {/* Project cards */}
      <div className="dash-section">
        <h3 className="dash-section-title">Projects</h3>
        {projects.length === 0 ? (
          <div className="empty-state empty-state-compact">
            <p className="empty-state-hint">No projects yet. Create one from the sidebar to track your work.</p>
          </div>
        ) : (
        <div className="dash-project-grid">
          {projects.map((proj) => {
            const projTodos = todos.filter((t) => t.project_id === proj.id);
            const projCounts = statusCounts(projTodos);
            const projTotal = projTodos.length;
            const projCompleted = projCounts["completed"] || 0;
            const projActive = projTotal - projCompleted;
            const summary = projectSummaries[proj.id];

            // Most recent activity
            const latestTodo = projTodos.reduce<string | null>((latest, t) => {
              const ts = t.completed_at || t.created_at;
              return !latest || ts > latest ? ts : latest;
            }, null);

            const lastActivity = latestTodo
              ? formatRelative(latestTodo)
              : "No activity";

            return (
              <div
                key={proj.id}
                className="dash-project-card"
                onClick={() => onSelectProject(proj.id)}
              >
                <div className="dash-project-header">
                  <div className="dash-project-info">
                    <span className="dash-project-name">{getDisplayName(proj.id) ?? proj.name}</span>
                    <span className="dash-project-activity">{lastActivity}</span>
                  </div>
                  <ProgressRing completed={projCompleted} total={projTotal} />
                </div>
                {summary && <p className="dash-project-summary">{summary}</p>}
                <StatusBar counts={projCounts} total={projTotal} />
                <div className="dash-project-stats">
                  <span>{projActive} active</span>
                  <span>{projCompleted} done</span>
                  <span>{projTotal} total</span>
                </div>
                {proj.auto_run_quota > 0 && (
                  <span className="dash-autopilot-badge" title="Runs on next analysis cycle">🚀 {proj.auto_run_quota} left to run</span>
                )}
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
