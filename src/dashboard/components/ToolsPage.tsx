import { useFetch } from './useFetch';
import type { ToolComparison } from './types';

export default function ToolsPage({ filterStr }: { filterStr: string }) {
  const { data, loading, error } = useFetch<{ tools: ToolComparison[] }>('/api/tools' + filterStr, [filterStr]);

  if (loading) return <div className="loading"><div className="loading-spinner" /><span className="loading-pulse">Comparing tools…</span></div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p></div>;

  return (
    <div className="card">
      <h2>Tool Comparison</h2>
      {!data || data.tools.length === 0 ? (
        <div className="empty"><p>No tool data available. Import sessions first.</p></div>
      ) : (
        <table>
          <thead><tr><th>Tool</th><th>Sessions</th><th>Annotations</th><th>Score</th></tr></thead>
          <tbody>
            {data.tools.map(t => (
              <tr key={t.toolId}>
                <td><span className="tag">{t.toolId}</span></td>
                <td>{t.sessionCount}</td>
                <td>{t.outcomeCount}</td>
                <td>
                  <div className="score-bar"><div className="score-fill" style={{ width: Math.round(t.score * 100) + '%', background: t.score >= 0.7 ? '#22c55e' : t.score >= 0.4 ? '#eab308' : '#ef4444' }}></div></div>
                  {Math.round(t.score * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
