import type { SessionPrItem } from '../../api/contract.js';

export default function PRCard({ prs }: { prs: SessionPrItem[] }) {
  if (prs.length === 0) return null;
  return (
    <div className="card">
      <h2>Pull requests</h2>
      <table>
        <thead>
          <tr><th>#</th><th>Title</th><th>State</th><th>Link</th></tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <tr key={pr.prNumber}>
              <td><code>#{pr.prNumber}</code></td>
              <td>{pr.title}{pr.reverted && <span style={{ color: '#ef4444', marginLeft: 8, fontSize: '0.85em' }}>(reverted)</span>}</td>
              <td>
                <span style={{
                  padding: '2px 8px', borderRadius: 12, fontSize: '0.75em', fontWeight: 600,
                  background: pr.state === 'merged' ? '#22c55e22' : pr.state === 'open' ? '#fbbf2422' : '#94a3b822',
                  color: pr.state === 'merged' ? '#22c55e' : pr.state === 'open' ? '#fbbf24' : '#94a3b8',
                }}>
                  {pr.state}
                </span>
              </td>
              <td><a href={pr.url} target="_blank" rel="noopener noreferrer">open</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
