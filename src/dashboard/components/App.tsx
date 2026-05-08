import React, { useState, useEffect, lazy, Suspense } from 'react';
import type { Page } from './types';
import ProjectFilterSelect from './ProjectFilterSelect';

/** Read initial page from URL hash, default to overview. */
function getPageFromHash(): Page {
  const hash = window.location.hash.replace('#', '');
  if (['overview', 'timeline', 'tools', 'export'].includes(hash)) return hash as Page;
  return 'overview';
}

// Lazy-loaded page components
const OverviewPage = lazy(() => import('./OverviewPage'));
const TimelinePage = lazy(() => import('./TimelinePage'));
const ToolsPage = lazy(() => import('./ToolsPage'));
const ExportPage = lazy(() => import('./ExportPage'));
const SessionDetailView = lazy(() => import('./SessionDetailView'));

function PageLoader({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="loading">Loading...</div>}>
      {children}
    </Suspense>
  );
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
        <PageLoader>
          <SessionDetailView sessionId={selectedSession} onBack={() => setSelectedSession(null)} />
        </PageLoader>
      ) : (
        <>
          {page === 'overview' && (
            <PageLoader>
              <OverviewPage filterStr={filterStr} />
            </PageLoader>
          )}
          {page === 'timeline' && (
            <PageLoader>
              <TimelinePage filterStr={filterStr} onSelectSession={setSelectedSession} />
            </PageLoader>
          )}
          {page === 'tools' && (
            <PageLoader>
              <ToolsPage filterStr={filterStr} />
            </PageLoader>
          )}
          {page === 'export' && (
            <PageLoader>
              <ExportPage filterStr={filterStr} />
            </PageLoader>
          )}
        </>
      )}
    </div>
  );
}
