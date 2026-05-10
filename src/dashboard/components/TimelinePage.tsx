import { useFetch } from './useFetch';
import type { TimelineSession } from './types';
import ShipStatusPill from './ShipStatusPill';

export default function TimelinePage({ filterStr, onSelectSession }: { filterStr: string; onSelectSession: (id: string) => void }) {
  const { data, loading, error } = useFetch<{ sessions: TimelineSession[]; total: number }>('/api/timeline' + filterStr, [filterStr]);

  if (loading) return <div className="loading"><div className="loading-spinner" /><span className="loading-pulse">Loading timeline…</span></div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p></div>;

  return (
    <>
      <div className="card">
        <h2>Session Timeline ({data?.total || 0} sessions)</h2>
        {!data || data.sessions.length === 0 ? (
          <div className="empty"><p>No sessions match the current filters.</p></div>
        ) : (
          <table>
            <thead><tr><th>Tool</th><th>Project</th><th>Summary</th><th>Started</th><th>Duration</th><th>Model</th><th>Corr.</th><th>Outcome</th><th>Ship</th><th>Rework</th></tr></thead>
            <tbody>
              {data.sessions.map(s => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => onSelectSession(s.id)}>
                  <td><span className="tag">{s.sourceToolId}</span></td>
                  <td style={{ color: '#94a3b8', fontSize: '0.75rem' }}>{s.projectId || '-'}</td>
                  <td>{s.summary || s.id}</td>
                  <td>{s.startedAt ? new Date(s.startedAt).toLocaleDateString() : 'N/A'}</td>
                  <td>{s.durationMs ? Math.round(s.durationMs / 60000) + 'min' : 'N/A'}</td>
                  <td style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{s.model || '-'}</td>
                  <td>{s.correlationCount > 0 ? <span className="correlation-badge high">{s.correlationCount}</span> : <span style={{color: '#64748b'}}>0</span>}</td>
                  <td>{s.hasOutcome ? <span className="tag">{s.outcomeLabels[0]}</span> : <span style={{color: '#64748b'}}>-</span>}</td>
                  <td><ShipStatusPill value={s.shipStatus} /></td>
                  <td>{s.reworkCount > 0 ? <span style={{color: '#fbbf24', fontWeight: 'bold'}}>↺{s.reworkCount}</span> : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
