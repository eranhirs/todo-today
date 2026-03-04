import type { Insight } from "../types";
import { api } from "../api";

interface Props {
  insights: Insight[];
  onRefresh: () => void;
}

export function Insights({ insights, onRefresh }: Props) {
  const active = insights.filter((i) => !i.dismissed);
  if (active.length === 0) return null;

  const handleDismiss = async (id: string) => {
    try {
      await api.dismissInsight(id);
      onRefresh();
    } catch (err) {
      console.error("Failed to dismiss insight:", err);
    }
  };

  return (
    <div className="insights-banner">
      <div className="insights-header">Insights</div>
      {active.map((insight) => (
        <div key={insight.id} className="insight-card">
          <span className="insight-text">{insight.text}</span>
          <button
            className="btn-icon btn-dismiss-insight"
            onClick={() => handleDismiss(insight.id)}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
