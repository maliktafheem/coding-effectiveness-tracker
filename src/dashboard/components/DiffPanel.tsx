import { useState } from 'react';
import { useFetch } from './useFetch';

interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

interface CommitDiff {
  hash: string;
  shortHash: string;
  message: string | null;
  stats: DiffStats;
  diff?: string;
  skipped?: 'too-large' | 'repo-missing';
}

interface DiffResponse {
  commits: CommitDiff[];
}

export default function DiffPanel({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const url = expanded
    ? `/api/sessions/${encodeURIComponent(sessionId)}/diff${refreshTick > 0 ? `?refresh=1&r=${refreshTick}` : ''}`
    : '';

  const { data, loading, error } = useFetch<DiffResponse>(url, [expanded, refreshTick]);

  const total = data?.commits.reduce(
    (acc, c) => ({
      files: acc.files + c.stats.files,
      insertions: acc.insertions + c.stats.insertions,
      deletions: acc.deletions + c.stats.deletions,
    }),
    { files: 0, insertions: 0, deletions: 0 },
  );

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Code impact</h2>
        <button className="btn btn-secondary" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Hide diff' : 'View diff'}
        </button>
      </div>

      {expanded && loading && (
        <p style={{ color: '#94a3b8', marginTop: 12 }}>Loading diff…</p>
      )}
      {expanded && error && (
        <p style={{ color: '#ef4444', marginTop: 12 }}>{error}</p>
      )}
      {expanded && data && data.commits.length === 0 && (
        <p style={{ color: '#94a3b8', marginTop: 12 }}>No commits linked to this session.</p>
      )}
      {expanded && data && data.commits.length > 0 && total && (
        <p style={{ color: '#94a3b8', marginTop: 12, marginBottom: 16 }}>
          {data.commits.length} commit{data.commits.length === 1 ? '' : 's'}, {total.files} file
          {total.files === 1 ? '' : 's'} touched, +{total.insertions}/-{total.deletions}
        </p>
      )}
      {expanded && data && data.commits.map((c) => (
        <CommitBlock key={c.hash} commit={c} onRefresh={() => setRefreshTick((t) => t + 1)} />
      ))}
    </div>
  );
}

function CommitBlock({ commit, onRefresh }: { commit: CommitDiff; onRefresh: () => void }) {
  return (
    <div style={{ borderTop: '1px solid #1e293b', paddingTop: 12, marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <code style={{ color: '#60a5fa' }}>{commit.shortHash}</code>
        <span>{commit.message ?? ''}</span>
        <span style={{ color: '#94a3b8', fontSize: '0.85em', marginLeft: 'auto' }}>
          {commit.stats.files} file{commit.stats.files === 1 ? '' : 's'}, +{commit.stats.insertions}/-{commit.stats.deletions}
        </span>
      </div>
      {commit.skipped === 'too-large' && (
        <p style={{ color: '#fbbf24', marginTop: 8 }}>
          Diff too large to cache.{' '}
          <button className="btn btn-secondary" onClick={onRefresh}>Fetch anyway</button>
        </p>
      )}
      {commit.skipped === 'repo-missing' && (
        <p style={{ color: '#fbbf24', marginTop: 8 }}>
          Repo not found at the session's recorded path.
        </p>
      )}
      {commit.diff && (
        <pre style={{
          marginTop: 8,
          background: '#0f172a',
          padding: '0.75rem',
          borderRadius: 6,
          overflowX: 'auto',
          fontSize: '0.8rem',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          lineHeight: 1.45,
          whiteSpace: 'pre',
        }}>
          {renderDiffLines(commit.diff)}
        </pre>
      )}
    </div>
  );
}

function renderDiffLines(diff: string) {
  return diff.split('\n').map((line, i) => {
    let color: string | undefined;
    if (line.startsWith('+') && !line.startsWith('+++')) color = '#22c55e';
    else if (line.startsWith('-') && !line.startsWith('---')) color = '#ef4444';
    else if (line.startsWith('@@')) color = '#60a5fa';
    return (
      <span key={i} style={color ? { color } : undefined}>
        {line}
        {'\n'}
      </span>
    );
  });
}
