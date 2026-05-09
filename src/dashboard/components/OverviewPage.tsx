import { useFetch } from './useFetch';
import type { OverviewData } from './types';

const DIMENSION_HINTS: Record<string, string> = {
  'activity-output': 'Run more AI sessions to increase activity. Try cet setup for automated onboarding.',
  'git-correlation': 'Sync a git repo with cet sync to link commits. Run AI sessions in git-tracked directories.',
  'test-confidence': 'Run cet test -- <command> after sessions to capture test outcomes.',
  'manual-outcome': 'Annotate sessions with cet annotate --session <id> --outcome <label> --score <n>.',
  'cost-efficiency': 'Track cost/token data. Lower per-session costs improve this score. Adjust costCeiling in scoring.json.',
  'rework-indicator': 'Minimize retry/redo cycles. Fewer rework attempts yield a higher score.',
};

export default function OverviewPage({ filterStr }: { filterStr: string }) {
  const { data, loading, error } = useFetch<OverviewData>('/api/overview' + filterStr, [filterStr]);

  if (loading) return <div className="loading"><div className="loading-spinner" /><span className="loading-pulse">Analyzing session data…</span></div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p><p>Check that the server is running and try refreshing.</p><button className="btn btn-primary" onClick={() => window.location.reload()} style={{marginTop: 8}}>Retry</button></div>;
  if (!data || data.empty) return (
    <div className="empty">
      <h2>Welcome to Coding Effectiveness Tracker</h2>
      <p>{data?.message || 'No sessions recorded yet.'}</p>
      <div className="quick-start" style={{ marginTop: '1rem', textAlign: 'left', display: 'inline-block' }}>
        <p><strong>Quick start:</strong></p>
        <ul>
          <li><code>cet setup</code> — One-command onboarding</li>
          <li><code>cet import --tool claude-code --discover</code></li>
          <li><code>cet import --tool opencode --discover</code></li>
          <li><code>cet import --tool codex --discover</code></li>
          <li><code>cet test -- npm test</code> — Track test outcomes</li>
        </ul>
        <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', opacity: 0.7 }}>
          All data stays on your machine. No cloud sync or telemetry.
        </p>
      </div>
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
          <thead><tr><th>Dimension</th><th>Score</th><th>Weight</th><th>Explanation</th><th>How to Improve</th></tr></thead>
          <tbody>
            {data.score.dimensions.map(dim => (
              <tr key={dim.name}>
                <td>{dim.name}</td>
                <td>{dim.available ? Math.round(dim.value * 100) + '%' : 'unknown'}</td>
                <td>{Math.round(dim.weight * 100)}%</td>
                <td>{dim.explanation}</td>
                <td>{DIMENSION_HINTS[dim.name] || '—'}</td>
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
