import { useFetch } from './useFetch';
import type { PromptQualityResponse } from '../../api/contract.js';

export default function PromptQualityPage() {
  const { data, loading, error } = useFetch<PromptQualityResponse>('/api/prompt-quality', []);

  if (loading) return <div className="loading"><span className="loading-pulse">Loading prompt quality...</span></div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p></div>;
  if (!data) return null;

  if (data.sessions.length === 0) {
    return (
      <div className="card">
        <h2>Prompting</h2>
        <p style={{ color: '#94a3b8' }}>
          No prompt quality data yet. Run <code>cet prompt-quality</code> to score sessions.
        </p>
      </div>
    );
  }

  const sorted = [...data.sessions].sort((a, b) => b.overall - a.overall);
  const top = sorted.slice(0, 10);
  const worst = sorted.slice(-10).reverse();

  return (
    <>
      <div className="card">
        <h2>Prompting</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <div>
            <strong>Average quality</strong>
            <p style={{ fontSize: '2rem', margin: '4px 0' }}>{(data.avgOverall * 100).toFixed(0)}%</p>
          </div>
          <div>
            <strong>Sessions scored</strong>
            <p style={{ fontSize: '2rem', margin: '4px 0' }}>{data.sessions.length}</p>
          </div>
          <div>
            <strong>Analyzer</strong>
            <p style={{ fontSize: '1rem', margin: '4px 0' }}><code>{data.analyzer}</code></p>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Top 10 best prompts</h3>
        <table>
          <thead><tr><th>Score</th><th>Session</th><th>Tool</th><th>Started</th></tr></thead>
          <tbody>
            {top.map((s) => (
              <tr key={s.sessionId}>
                <td><strong>{(s.overall * 100).toFixed(0)}%</strong></td>
                <td><code>{s.sessionId.slice(0, 8)}</code></td>
                <td><span className="tag">{s.toolId}</span></td>
                <td>{s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Worst 10 prompts (learning opportunities)</h3>
        <table>
          <thead><tr><th>Score</th><th>Session</th><th>Tool</th><th>Started</th></tr></thead>
          <tbody>
            {worst.map((s) => (
              <tr key={s.sessionId}>
                <td><strong>{(s.overall * 100).toFixed(0)}%</strong></td>
                <td><code>{s.sessionId.slice(0, 8)}</code></td>
                <td><span className="tag">{s.toolId}</span></td>
                <td>{s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
