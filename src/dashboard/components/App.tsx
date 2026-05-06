import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = window.location.origin;

interface OverviewData {
  totalSessions: number;
  tools: string[];
  dateRange: { from: string | null; to: string | null };
  outcomeCount: number;
  score: { aggregate: number; dimensions: { name: string; value: number; explanation: string; available: boolean; weight: number }[]; missingInputs: string[] };
  empty: boolean;
  message?: string;
}

interface TimelineSession {
  id: string; sourceToolId: string; projectId: string | null;
  startedAt: string; endedAt: string | null; durationMs: number | null;
  summary: string | null; model: string | null;
  correlationCount: number;
  outcomeCount: number;
  outcomeLabels: string[];
  hasOutcome: boolean;
  reworkCount: number;
}

interface SessionDetail extends TimelineSession {
  externalId: string | null; tokensInput: number | null; tokensOutput: number | null;
  costEstimate: number | null; metadata: Record<string, unknown> | null;
  correlations: { id: string; type: string; targetId: string; confidence: number; reasons: string[] }[];
  outcomes: { id: string; type: string; label: string; score: number | null; note: string | null }[];
  uncorrelated: boolean;
}

interface ToolComparison {
  toolId: string; sessionCount: number; outcomeCount: number; score: number;
}

interface ProjectInfo {
  projectId: string; sessionCount: number;
}

type Page = 'overview' | 'timeline' | 'tools' | 'export';

/** Read initial page from URL hash, default to overview. */
function getPageFromHash(): Page {
  const hash = window.location.hash.replace('#', '');
  if (['overview', 'timeline', 'tools', 'export'].includes(hash)) return hash as Page;
  return 'overview';
}

function useFetch<T>(url: string, deps: unknown[] = []): { data: T | null; loading: boolean; error: string | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(API_BASE + url)
      .then(res => {
        if (!res.ok) throw new Error('API error: ' + res.status);
        return res.json();
      })
      .then(json => { if (!cancelled) setData(json); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url, tick, ...deps]);

  return { data, loading, error, refetch };
}

export function App() {
  const [page, setPage] = useState<Page>(getPageFromHash);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [toolFilter, setToolFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Sync page state to URL hash for refresh persistence
  useEffect(() => {
    window.location.hash = selectedSession ? 'session-' + selectedSession : page;
  }, [page, selectedSession]);

  // Check hash for session detail on mount
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash.startsWith('session-')) {
      const sid = hash.slice(8);
      if (sid) setSelectedSession(sid);
    }
  }, []);

  const filterParams = new URLSearchParams();
  if (toolFilter) filterParams.set('tool', toolFilter);
  if (projectFilter) filterParams.set('project', projectFilter);
  if (fromDate) filterParams.set('from', fromDate);
  if (toDate) filterParams.set('to', toDate);
  const filterStr = filterParams.toString() ? '?' + filterParams.toString() : '';

  return (
    <div className="container">
      <div className="header">
        <h1>Coding Effectiveness Tracker</h1>
        <div className="nav">
          <a href="#" className={page === 'overview' ? 'active' : ''} onClick={e => { e.preventDefault(); setPage('overview'); setSelectedSession(null); }}>Overview</a>
          <a href="#" className={page === 'timeline' ? 'active' : ''} onClick={e => { e.preventDefault(); setPage('timeline'); setSelectedSession(null); }}>Timeline</a>
          <a href="#" className={page === 'tools' ? 'active' : ''} onClick={e => { e.preventDefault(); setPage('tools'); setSelectedSession(null); }}>Tools</a>
          <a href="#" className={page === 'export' ? 'active' : ''} onClick={e => { e.preventDefault(); setPage('export'); }}>Export</a>
        </div>
      </div>

      <div className="filter-bar">
        <label style={{color: '#94a3b8', fontSize: '0.8rem'}}>Filter:</label>
        <select value={toolFilter} onChange={e => { setToolFilter(e.target.value); setSelectedSession(null); }}>
          <option value="">All tools</option>
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
          <option value="opencode">OpenCode</option>
          <option value="cursor">Cursor</option>
          <option value="factory-droid">Factory Droid</option>
        </select>
        <ProjectFilterSelect value={projectFilter} onChange={setProjectFilter} />
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} placeholder="From" />
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} placeholder="To" />
        {(toolFilter || projectFilter || fromDate || toDate) && <button className="btn btn-secondary" onClick={() => { setToolFilter(''); setProjectFilter(''); setFromDate(''); setToDate(''); setSelectedSession(null); }}>Clear</button>}
      </div>

      {selectedSession ? (
        <SessionDetailView sessionId={selectedSession} onBack={() => setSelectedSession(null)} />
      ) : (
        <>
          {page === 'overview' && <OverviewPage filterStr={filterStr} />}
          {page === 'timeline' && <TimelinePage filterStr={filterStr} onSelectSession={setSelectedSession} />}
          {page === 'tools' && <ToolsPage />}
          {page === 'export' && <ExportPage filterStr={filterStr} />}
        </>
      )}
    </div>
  );
}

function ProjectFilterSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useFetch<{ projects: ProjectInfo[] }>('/api/projects');
  return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      <option value="">All projects</option>
      {(data?.projects || []).map(p => (
        <option key={p.projectId} value={p.projectId}>{p.projectId} ({p.sessionCount})</option>
      ))}
    </select>
  );
}

function OverviewPage({ filterStr }: { filterStr: string }) {
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

function TimelinePage({ filterStr, onSelectSession }: { filterStr: string; onSelectSession: (id: string) => void }) {
  const { data, loading, error } = useFetch<{ sessions: TimelineSession[]; total: number }>('/api/timeline' + filterStr, [filterStr]);

  if (loading) return <div className="loading">Loading timeline...</div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p></div>;

  return (
    <>
      <div className="card">
        <h2>Session Timeline ({data?.total || 0} sessions)</h2>
        {!data || data.sessions.length === 0 ? (
          <div className="empty"><p>No sessions match the current filters.</p></div>
        ) : (
          <table>
            <thead><tr><th>Tool</th><th>Project</th><th>Summary</th><th>Started</th><th>Duration</th><th>Model</th><th>Corr.</th><th>Outcome</th><th>Rework</th></tr></thead>
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

function ToolsPage() {
  const { data, loading, error } = useFetch<{ tools: ToolComparison[] }>('/api/tools');

  if (loading) return <div className="loading">Loading tool comparison...</div>;
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

function SessionDetailView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { data, loading, error, refetch } = useFetch<SessionDetail>('/api/sessions/' + sessionId, [sessionId]);
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

  if (loading) return <div className="loading">Loading session...</div>;
  if (error) return <div className="error"><h2>Error</h2><p>{error}</p></div>;
  if (!data) return null;

  // Score dimension summary from overview
  const { data: overviewData } = useFetch<OverviewData>('/api/overview', []);

  return (
    <>
      <button className="btn btn-secondary" onClick={onBack} style={{ marginBottom: 16 }}>Back to Timeline</button>
      <div className="card">
        <h2>{data.summary || data.id}</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <div><strong>Tool:</strong> <span className="tag">{data.sourceToolId}</span></div>
          {data.projectId && <div><strong>Project:</strong> <span className="tag">{data.projectId}</span></div>}
          <div><strong>Model:</strong> {data.model || 'N/A'}</div>
          <div><strong>Started:</strong> {data.startedAt ? new Date(data.startedAt).toLocaleString() : 'N/A'}</div>
          <div><strong>Duration:</strong> {data.durationMs ? Math.round(data.durationMs / 60000) + ' min' : 'N/A'}</div>
          {data.tokensInput != null && <div><strong>Tokens In:</strong> {data.tokensInput.toLocaleString()}</div>}
          {data.tokensOutput != null && <div><strong>Tokens Out:</strong> {data.tokensOutput.toLocaleString()}</div>}
          {data.costEstimate != null && <div><strong>Cost:</strong> </div>}
          {data.reworkCount > 0 && <div><strong>Rework:</strong> <span style={{color: '#fbbf24', fontWeight: 'bold'}}>{data.reworkCount} rework attempt(s)</span></div>}
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
            Aggregate score: {Math.round(overviewData.score.aggregate * 100)}%. Only available dimensions contribute to the weighted average; unavailable dimensions do not lower the score.
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

function AnnotationForm({ onSubmit }: { onSubmit: (form: { outcome: string; score: string; note: string }) => void }) {
  const [outcome, setOutcome] = useState('good');
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = () => {
    // Validate score range
    if (score) {
      const num = parseFloat(score);
      if (isNaN(num) || num < 0 || num > 1) {
        setValidationError('Score must be a number between 0 and 1.');
        return;
      }
    }
    setValidationError(null);
    onSubmit({ outcome, score, note });
  };

  return (
    <div className="annotation-form" style={{ marginTop: 12 }}>
      {validationError && <div className="error" style={{ marginBottom: 8, padding: '8px 12px', fontSize: '0.8rem' }}>{validationError}</div>}
      <div>
        <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8', fontSize: '0.8rem' }}>Outcome</label>
        <select value={outcome} onChange={e => setOutcome(e.target.value)}>
          {['good','accepted','merged','shipped','ok','neutral','partial','poor','rejected','reverted','abandoned','unknown'].map(o => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8', fontSize: '0.8rem' }}>Score (0-1, optional)</label>
        <input type="number" min="0" max="1" step="0.1" value={score} onChange={e => setScore(e.target.value)} placeholder="0.8" />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8', fontSize: '0.8rem' }}>Note (optional)</label>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Add a note..." />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={handleSubmit}>Save Annotation</button>
        <button className="btn btn-secondary" onClick={() => { setScore(''); setNote(''); setValidationError(null); }}>Reset</button>
      </div>
    </div>
  );
}

function ExportPage({ filterStr }: { filterStr: string }) {
  const [downloading, setDownloading] = useState<string | null>(null);

  const handleExport = async (format: 'json' | 'markdown') => {
    setDownloading(format);
    try {
      const res = await fetch(API_BASE + '/api/export/' + format + filterStr);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const ext = format === 'json' ? 'json' : 'md';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'effectiveness-report.' + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="card">
      <h2>Export Report</h2>
      <p style={{ color: '#94a3b8', marginBottom: 16 }}>Export the current dashboard state as a report file. All data stays local.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <label style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
          <input type="checkbox" id="rawExport" /> Include raw metadata (optional, privacy-sensitive)
        </label>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <button className="btn btn-primary" onClick={() => handleExport('json')} disabled={downloading !== null}>
          {downloading === 'json' ? 'Downloading...' : 'Export JSON'}
        </button>
        <button className="btn btn-secondary" onClick={() => handleExport('markdown')} disabled={downloading !== null}>
          {downloading === 'markdown' ? 'Downloading...' : 'Export Markdown'}
        </button>
      </div>
    </div>
  );
}
