import { useFetch } from './useFetch';
import type { TrendData } from './types';
import Chart from './Chart';

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
      <Chart
        points={points}
        width={WIDTH}
        height={HEIGHT}
        padding={PAD}
        yMax={maxScore}
        yTicks={[0, 0.25, 0.5, 0.75, 1]}
        formatY={(v) => `${Math.round(v * 100)}%`}
        formatX={(p) => formatWeek(p.weekStart)}
      >
        {({ padX, padY, stepX }) => {
          const sessionsToY = (v: number) => PAD.top + chartH - (v / maxSessions) * chartH;
          const barW = Math.max(stepX * 0.55, 3);

          const scoreLine = points
            .map((p, i) => `${padX(i).toFixed(1)},${padY(p.scoreAggregate).toFixed(1)}`)
            .join(' ');

          const areaPath = `M ${PAD.left} ${PAD.top + chartH} L ${scoreLine} L ${padX(points.length - 1)} ${PAD.top + chartH} Z`;

          return (
            <>
              {/* Session bars — staggered entrance */}
              {points.map((p, i) => (
                <rect
                  key={`bar-${i}`}
                  x={(padX(i) - barW / 2).toFixed(1)}
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
                    cx={padX(i).toFixed(1)}
                    cy={padY(p.scoreAggregate)}
                    r="4.5"
                    fill="var(--accent-cyan)"
                    opacity="0.12"
                    style={{ animation: `fadeSlideUp 0.4s ${0.6 + i * 0.05}s cubic-bezier(0.16, 1, 0.3, 1) both` }}
                  />
                  <circle
                    cx={padX(i).toFixed(1)}
                    cy={padY(p.scoreAggregate)}
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
            </>
          );
        }}
      </Chart>
    </div>
  );
}
