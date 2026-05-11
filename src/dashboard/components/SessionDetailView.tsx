import { useState } from 'react';
import { useFetch } from './useFetch';
import AnnotationForm from './AnnotationForm';
import DiffPanel from './DiffPanel';
import ShipStatusPill from './ShipStatusPill';
import PRCard from './PRCard';
import type { SessionDetail, OverviewData } from './types';

const API_BASE = window.location.origin;

export default function SessionDetailView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  // ALL hooks must run before any conditional returns (React rules of hooks)
  const { data, loading, error, refetch } = useFetch<SessionDetail>('/api/sessions/' + sessionId, [sessionId]);
  const { data: overviewData } = useFetch<OverviewData>('/api/overview', []);
  const [showAnnotationForm, setShowAnnotationForm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const submitAnnotation = async (form: { outcome: string; score: string; note: string }) => {
    // Frontend validation before sending
    const scoreNum = form.score ? parseFloat(form.score) : undefined;
    if (scoreNum !== undefined && (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 1)) {
      setToast('Error: Score must be between 0 and 1.');
      setTimeout(() => setToast(null), 3000);
      return;
    }
    try {
      const res = await fetch(API_BASE + '/api/sessions/' + sessionId + '/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome: form.outcome,
          score: scoreNum,
          note: form.note || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed to save annotation');
      }
      setShowAnnotationForm(false);
      setToast('Annotation saved!');
      setTimeout(() => setToast(null), 3000);
      refetch();
    } catch (err: unknown) {
      setToast('Error: ' + (err instanceof Error ? err.message : String(err)));
      setTimeout(() => setToast(null), 3000);
    }
  };

  if (loading) return <div className="loading"><div className="loading-spinner" /><span className="loading-pulse">Loading session details…</span></div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p></div>;
  if (!data) return null;

  return (
    <>
      <button className="btn btn-secondary" onClick={onBack} style={{ marginBottom: 16 }}>Back to Timeline</button>
      <div className="card">
        <h2>{data.summary || data.id}</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <div><strong>Tool:</strong> <span className="tag">{data.sourceToolId}</span></div>
          {data.projectId && <div><strong>Project:</strong> <span className="tag">{data.projectId}</span></div>}
          {data.externalId && (
            <div title="External session identifier from the source tool">
              <strong>External ID:</strong> <code style={{ fontSize: '0.85em', color: 'var(--text-muted, #94a3b8)' }}>{data.externalId}</code>
            </div>
          )}
          <div><strong>Model:</strong> {data.model || 'N/A'}</div>
          <div><strong>Started:</strong> {data.startedAt ? new Date(data.startedAt).toLocaleString() : 'N/A'}</div>
          <div><strong>Duration:</strong> {data.durationMs ? Math.round(data.durationMs / 60000) + ' min' : 'N/A'}</div>
          {data.tokensInput != null && <div><strong>Tokens In:</strong> {data.tokensInput.toLocaleString()}</div>}
          {data.tokensOutput != null && <div><strong>Tokens Out:</strong> {data.tokensOutput.toLocaleString()}</div>}
          {data.costEstimate != null && <div><strong>Cost:</strong> </div>}
          {data.reworkCount > 0 && <div><strong>Rework:</strong> <span style={{color: '#fbbf24', fontWeight: 'bold'}}>{data.reworkCount} rework attempt(s)</span></div>}
          {data.shipStatus !== undefined && <div><strong>Ship:</strong> <ShipStatusPill value={data.shipStatus} /></div>}
        </div>
      </div>

      {/* Score Weighting / Balance Inputs */}
      {overviewData && overviewData.score.dimensions.length > 0 && (
        <div className="card">
          <h2>Score Weighting &amp; Balance Inputs</h2>
          <table>
            <thead><tr><th>Dimension</th><th>Weight</th><th>Score</th><th>Status</th></tr></thead>
            <tbody>
              {overviewData.score.dimensions.map(dim => (
                <tr key={dim.name}>
                  <td>{dim.name}</td>
                  <td>{Math.round(dim.weight * 100)}%</td>
                  <td>{dim.available ? Math.round(dim.value * 100) + '%' : 'unknown'}</td>
                  <td>{dim.available ? <span style={{color: '#22c55e'}}>Available</span> : <span style={{color: '#94a3b8'}}>Unavailable</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{color: '#94a3b8', fontSize: '0.8rem', marginTop: 8}}>
            Aggregate score: {Math.round(overviewData.score.aggregate * 100)}%. All dimensions contribute to the denominator; missing dimensions contribute zero. See overview for evidence level.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Correlations</h2>
        {data.correlations.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No correlations found for this session. Run <code>cet sync</code> to correlate with Git/test outcomes.</p>
        ) : (
          <table>
            <thead><tr><th>Type</th><th>Confidence</th><th>Reasons</th></tr></thead>
            <tbody>
              {data.correlations.map(c => (
                <tr key={c.id}>
                  <td>{c.type}</td>
                  <td>
                    <span className={'correlation-badge ' + (c.confidence >= 0.7 ? 'high' : c.confidence >= 0.4 ? 'medium' : 'low')}>
                      {Math.round(c.confidence * 100)}%
                    </span>
                  </td>
                  <td>{c.reasons.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.promptQuality && (
        <div className="card">
          <h2>Prompt quality</h2>
          <div style={{ display: 'flex', gap: 24, alignItems: 'baseline' }}>
            <p style={{ fontSize: '2rem', margin: 0 }}>
              {(data.promptQuality.overall * 100).toFixed(0)}%
            </p>
            <span style={{ color: '#94a3b8' }}>
              <code>{data.promptQuality.analyzerId}@{data.promptQuality.analyzerVersion}</code>
              {' · '}
              computed {new Date(data.promptQuality.computedAt).toLocaleDateString()}
            </span>
          </div>
          <div style={{ marginTop: 16 }}>
            {Object.entries(data.promptQuality.signals).map(([name, value]) => (
              <div key={name} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 50px', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ color: '#cbd5e1' }}>{name}</span>
                <div style={{ background: '#1e293b', height: 8, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ background: '#22c55e', height: '100%', width: `${value * 100}%` }} />
                </div>
                <span style={{ color: '#94a3b8', textAlign: 'right' }}>{(value * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <PRCard prs={data.prs ?? []} />

      <DiffPanel sessionId={sessionId} />

      <div className="card">
        <h2>Annotations</h2>
        {data.outcomes.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No annotations yet.</p>
        ) : (
          <table>
            <thead><tr><th>Type</th><th>Label</th><th>Score</th><th>Note</th></tr></thead>
            <tbody>
              {data.outcomes.map(o => (
                <tr key={o.id}>
                  <td>{o.type}</td>
                  <td><span className="tag">{o.label}</span></td>
                  <td>{o.score != null ? Math.round(o.score * 100) + '%' : '-'}</td>
                  <td>{o.note || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => setShowAnnotationForm(!showAnnotationForm)}>
            {showAnnotationForm ? 'Cancel' : 'Add Annotation'}
          </button>
        </div>
        {showAnnotationForm && <AnnotationForm onSubmit={submitAnnotation} />}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
