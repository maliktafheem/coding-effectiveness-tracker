import { useFetch } from './useFetch';
import type { OverviewData } from './types';

export default function OverviewPage({ filterStr }: { filterStr: string }) {
  const { data, loading, error } = useFetch<OverviewData>('/api/overview' + filterStr, [filterStr]);

  if (loading) return <div className="loading">Loading overview...</div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p><p>Check that the server is running and try refreshing.</p><button className="btn btn-primary" onClick={() => window.location.reload()} style={{marginTop: 8}}>Retry</button></div>;
  if (!data || data.empty) return (
    <div className="empty">
      <h2>No Sessions Available</h2>
      <p>{data?.message || 'No sessions found. Import data with: cet import --fixture <path>'}</p>
    </div>
  );

  const pct = Math.round(data.score.aggregate * 100);
  const fillColor = pct >= 70 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444';

  return (
    <>
      <div className="grid">
        <div className="card stat">
          <div className="value">{data.totalSessions}</div>
          <div className="label">Sessions</div>
        </div>
        <div className="card stat">
          <div className="value">{data.tools.length}</div>
          <div className="label">Tools</div>
        </div>
        <div className="card stat">
          <div className="value">{data.outcomeCount}</div>
          <div className="label">Annotations</div>
        </div>
        <div className="card stat">
          <div className="value">{pct}%</div>
          <div className="label">Effectiveness</div>
          <div className="score-bar"><div className="score-fill" style={{ width: pct + '%', background: fillColor }}></div></div>
        </div>
      </div>

      <div className="card">
        <h2>Score Dimensions</h2>
        <table>
          <thead><tr><th>Dimension</th><th>Score</th><th>Weight</th><th>Explanation</th></tr></thead>
          <tbody>
            {data.score.dimensions.map(dim => (
              <tr key={dim.name}>
                <td>{dim.name}</td>
                <td>{dim.available ? Math.round(dim.value * 100) + '%' : 'unknown'}</td>
                <td>{Math.round(dim.weight * 100)}%</td>
                <td>{dim.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.score.missingInputs.length > 0 && (
        <div className="card">
          <h2>Missing / Partial Inputs</h2>
          <ul>{data.score.missingInputs.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}

      <div className="card">
        <h2>Period</h2>
        <p>{data.dateRange.from || 'N/A'} to {data.dateRange.to || 'N/A'}</p>
        <p>Tools: {data.tools.join(', ')}</p>
      </div>
    </>
  );
}
