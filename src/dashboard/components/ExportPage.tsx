import { useState } from 'react';

const API_BASE = window.location.origin;

export default function ExportPage({ filterStr }: { filterStr: string }) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [rawExport, setRawExport] = useState(false);

  const handleExport = async (format: 'json' | 'markdown') => {
    setDownloading(format);
    // Append raw=true only when explicitly opted in
    const urlSuffix = rawExport
      ? (filterStr ? filterStr + '&raw=true' : '?raw=true')
      : filterStr;
    try {
      const res = await fetch(API_BASE + '/api/export/' + format + urlSuffix);
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
          <input type="checkbox" id="rawExport" checked={rawExport} onChange={e => setRawExport(e.target.checked)} /> Include raw metadata (optional, privacy-sensitive)
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
