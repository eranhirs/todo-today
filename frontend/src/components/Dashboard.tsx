import type { AnalysisEntry, Project, Todo } from "../types";

interface Props {
  todos: Todo[];
  projects: Project[];
  projectSummaries: Record<string, string>;
  history: AnalysisEntry[];
  onSelectProject: (id: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  next: "var(--text-dim)",
  in_progress: "var(--blue)",
  completed: "var(--green)",
  consider: "#636e88",
  waiting: "var(--amber)",
  stale: "var(--red)",
};

const STATUS_LABELS: Record<string, string> = {
  next: "Next",
  in_progress: "In Progress",
  completed: "Done",
  consider: "Consider",
  waiting: "Waiting",
  stale: "Stale",
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
  const order = ["waiting", "in_progress", "next", "consider", "stale", "completed"];
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

export function Dashboard({ todos, projects, projectSummaries, history, onSelectProject }: Props) {
  const allCounts = statusCounts(todos);
  const totalTodos = todos.length;
  const completedCount = allCounts["completed"] || 0;
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
          {["waiting", "in_progress", "next", "consider", "stale", "completed"].map((s) => {
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

      {/* Project cards */}
      <div className="dash-section">
        <h3 className="dash-section-title">Projects</h3>
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
                    <span className="dash-project-name">{proj.name}</span>
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
