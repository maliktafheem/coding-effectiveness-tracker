import type React from 'react';
import { useId } from 'react';

export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartRenderCtx {
  padX: (i: number) => number;
  padY: (v: number) => number;
  stepX: number;
  chartW: number;
  chartH: number;
  /** Unique ref for the chart's scoped <defs>. Use `gradientUrl` / `glowUrl` in fill/filter attrs. */
  gradientId: string;
  glowId: string;
  gridId: string;
  gradientUrl: string;
  glowUrl: string;
  gridUrl: string;
}

export interface ChartProps<T> {
  points: T[];
  width?: number;
  height?: number;
  padding?: ChartPadding;
  yMax: number;
  yTicks?: number[];
  formatY: (v: number) => string;
  formatX: (point: T, i: number) => string;
  children: (ctx: ChartRenderCtx) => React.ReactNode;
}

export default function Chart<T>({
  points,
  width = 720,
  height = 260,
  padding = { top: 28, right: 24, bottom: 36, left: 56 },
  yMax,
  yTicks = [0, 0.25, 0.5, 0.75, 1],
  formatY,
  formatX,
  children,
}: ChartProps<T>) {
  const PAD = padding;
  const chartW = width - PAD.left - PAD.right;
  const chartH = height - PAD.top - PAD.bottom;

  const stepX = points.length > 1 ? chartW / (points.length - 1) : chartW;

  const padX = (i: number) => PAD.left + i * stepX;
  const padY = (v: number) => PAD.top + chartH - (v / yMax) * chartH;

  // useId produces a unique string per component instance. Strip any ':' so
  // the result is safe inside SVG id attributes and url(#...) references.
  const rawId = useId().replace(/:/g, '');
  const gradientId = `scoreGradient-${rawId}`;
  const glowId = `glow-${rawId}`;
  const gridId = `chartGrid-${rawId}`;
  const gradientUrl = `url(#${gradientId})`;
  const glowUrl = `url(#${glowId})`;
  const gridUrl = `url(#${gridId})`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10px' }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.02" />
        </linearGradient>
        <filter id={glowId}>
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <pattern id={gridId} width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M 12 0 L 0 0 0 12" fill="none" stroke="var(--border-subtle)" strokeWidth="0.3" opacity="0.4" />
        </pattern>
      </defs>

      {/* Chart background */}
      <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} fill={gridUrl} opacity="0.5" />

      {/* Horizontal grid lines with staggered entrance */}
      {yTicks.map((tick, ti) => {
        const y = padY(tick * yMax);
        return (
          <g key={tick} style={{ animation: `fadeSlideRight 0.5s ${0.1 + ti * 0.1}s cubic-bezier(0.16, 1, 0.3, 1) both` }}>
            <line
              x1={PAD.left} y1={y} x2={width - PAD.right} y2={y}
              stroke="var(--border-subtle)" strokeWidth="0.5" strokeDasharray="2,4" opacity="0.5"
            />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" fill="var(--text-muted)" fontSize="9" letterSpacing="0.04em">
              {formatY(tick * yMax)}
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
            x={padX(i)}
            y={height - 8}
            textAnchor="middle"
            fill="var(--text-muted)"
            fontSize="9"
            letterSpacing="0.03em"
            style={{ animation: `fadeSlideUp 0.4s ${0.3 + i * 0.05}s cubic-bezier(0.16, 1, 0.3, 1) both` }}
          >
            {formatX(p, i)}
          </text>
        );
      })}

      {/* Chart-specific content via render prop */}
      {children({ padX, padY, stepX, chartW, chartH, gradientId, glowId, gridId, gradientUrl, glowUrl, gridUrl })}

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
    </svg>
  );
}
