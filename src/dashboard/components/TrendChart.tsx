import { useFetch } from './useFetch';
import type { TrendData } from './types';

export default function TrendChart({ filterStr }: { filterStr: string }) {
  const { data, loading, error } = useFetch<TrendData>(
    '/api/trends' + filterStr,
    [filterStr],
  );

  if (loading) return <div className="loading"><div className="loading-spinner" /><span className="loading-pulse">Computing trends…</span></div>;
  if (error) return null;
  if (!data || data.points.length === 0) return <div className="empty"><p>Not enough data for trends. Import more sessions over time.</p></div>;

  const { points } = data;
  const maxScore = Math.max(...points.map(p => p.scoreAggregate), 0.1);
  const maxSessions = Math.max(...points.map(p => p.sessionCount), 1);

  const WIDTH = 720;
  const HEIGHT = 260;
  const PAD = { top: 28, right: 24, bottom: 36, left: 56 };
  const chartW = WIDTH - PAD.left - PAD.right;
  const chartH = HEIGHT - PAD.top - PAD.bottom;

  const stepX = points.length > 1 ? chartW / (points.length - 1) : chartW;
  const barW = Math.max(stepX * 0.55, 3);

  const scoreToY = (v: number) => PAD.top + chartH - (v / maxScore) * chartH;
  const sessionsToY = (v: number) => PAD.top + chartH - (v / maxSessions) * chartH;

  const scoreLine = points
    .map((p, i) => `${(PAD.left + i * stepX).toFixed(1)},${scoreToY(p.scoreAggregate).toFixed(1)}`)
    .join(' ');

  const areaPath = `M ${PAD.left} ${PAD.top + chartH} L ${scoreLine} L ${PAD.left + (points.length - 1) * stepX} ${PAD.top + chartH} Z`;

  const formatWeek = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const lineLength = Math.sqrt(points.length > 1
    ? (chartW) * (chartW) + (chartH) * (chartH)
    : chartH) + 200;

  return (
    <div className="card">
      <h2>Effectiveness Trends</h2>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: '100%', height: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10px' }}
      >
        <defs>
          <linearGradient id="scoreGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.02" />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>

          {/* Grid texture pattern */}
          <pattern id="chartGrid" width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M 12 0 L 0 0 0 12" fill="none" stroke="var(--border-subtle)" strokeWidth="0.3" opacity="0.4" />
          </pattern>
        </defs>

        {/* Chart background */}
        <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} fill="url(#chartGrid)" opacity="0.5" />

        {/* Horizontal grid lines with staggered entrance */}
        {[0, 0.25, 0.5, 0.75, 1].map((tick, ti) => {
          const y = scoreToY(tick * maxScore);
          return (
            <g key={tick} style={{ animation: `fadeSlideRight 0.5s ${0.1 + ti * 0.1}s cubic-bezier(0.16, 1, 0.3, 1) both` }}>
              <line
                x1={PAD.left} y1={y} x2={WIDTH - PAD.right} y2={y}
                stroke="var(--border-subtle)" strokeWidth="0.5" strokeDasharray="2,4" opacity="0.5"
              />
              <text x={PAD.left - 8} y={y + 4} textAnchor="end" fill="var(--text-muted)" fontSize="9" letterSpacing="0.04em">
                {Math.round(tick * maxScore * 100)}%
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {points.map((p, i) => {
          if (points.length > 12 && i % Math.max(1, Math.floor(points.length / 8)) !== 0) return null;
          return (
            <text
              key={i}
              x={PAD.left + i * stepX}
              y={HEIGHT - 8}
              textAnchor="middle"
              fill="var(--text-muted)"
              fontSize="9"
              letterSpacing="0.03em"
              style={{ animation: `fadeSlideUp 0.4s ${0.3 + i * 0.05}s cubic-bezier(0.16, 1, 0.3, 1) both` }}
            >
              {formatWeek(p.weekStart)}
            </text>
          );
        })}

        {/* Session bars — staggered entrance */}
        {points.map((p, i) => (
          <rect
            key={`bar-${i}`}
            x={(PAD.left + i * stepX - barW / 2).toFixed(1)}
            y={sessionsToY(p.sessionCount)}
            width={barW}
            height={Math.max(chartH - sessionsToY(p.sessionCount) + PAD.top, 1)}
            fill="var(--accent-violet)"
            opacity="0.12"
            rx="1.5"
            style={{ animation: `fadeSlideUp 0.5s ${0.15 + i * 0.04}s cubic-bezier(0.16, 1, 0.3, 1) both` }}
          >
            <title>{formatWeek(p.weekStart)}: {p.sessionCount} sessions</title>
          </rect>
        ))}

        {/* Area fill under score line */}
        <path
          d={areaPath}
          fill="url(#scoreGradient)"
          style={{ animation: `fadeSlideUp 0.6s 0.5s cubic-bezier(0.16, 1, 0.3, 1) both` }}
        />

        {/* Score line — animated drawing */}
        <polyline
          points={scoreLine}
          fill="none"
          stroke="var(--accent-cyan)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#glow)"
          strokeDasharray={lineLength}
          strokeDashoffset={lineLength}
          style={{ animation: `drawLine 1.2s 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards` }}
        />

        {/* Data point dots — staggered pop-in */}
        {points.map((p, i) => (
          <g key={`dot-${i}`}>
            <circle
              cx={(PAD.left + i * stepX).toFixed(1)}
              cy={scoreToY(p.scoreAggregate)}
              r="4.5"
              fill="var(--accent-cyan)"
              opacity="0.12"
              style={{ animation: `fadeSlideUp 0.4s ${0.6 + i * 0.05}s cubic-bezier(0.16, 1, 0.3, 1) both` }}
            />
            <circle
              cx={(PAD.left + i * stepX).toFixed(1)}
              cy={scoreToY(p.scoreAggregate)}
              r="2.5"
              fill="var(--accent-cyan)"
              stroke="var(--bg-card)"
              strokeWidth="1"
              style={{ animation: `fadeSlideUp 0.4s ${0.6 + i * 0.05}s cubic-bezier(0.16, 1, 0.3, 1) both` }}
            >
              <title>{formatWeek(p.weekStart)}: {Math.round(p.scoreAggregate * 100)}% — {p.sessionCount} sessions, {p.sessionsWithGit} git-linked</title>
            </circle>
          </g>
        ))}

        {/* Legend */}
        <g transform={`translate(${PAD.left}, ${PAD.top - 12})`} style={{ animation: `fadeSlideRight 0.5s 0.8s cubic-bezier(0.16, 1, 0.3, 1) both` }}>
          <line x1="0" y1="0" x2="18" y2="0" stroke="var(--accent-cyan)" strokeWidth="2" filter="url(#glow)" />
          <text x="24" y="4" fill="var(--text-secondary)" fontSize="10" letterSpacing="0.04em">Effectiveness Score</text>
          <rect x="168" y="-5" width="18" height="10" fill="var(--accent-violet)" opacity="0.25" rx="2" />
          <text x="192" y="4" fill="var(--text-secondary)" fontSize="10" letterSpacing="0.04em">Session Volume</text>
        </g>
      </svg>

      <style>{`
        @keyframes drawLine {
          to { stroke-dashoffset: 0; }
        }
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeSlideRight {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
