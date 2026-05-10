import type { ShipStatus } from '../../api/contract.js';

const LABELS: Record<ShipStatus, string> = {
  shipped: 'Shipped',
  reverted: 'Reverted',
  abandoned: 'Abandoned',
  'in-flight': 'In flight',
  unlinked: '—',
};

const COLORS: Record<ShipStatus, string> = {
  shipped: '#22c55e',
  reverted: '#ef4444',
  abandoned: '#94a3b8',
  'in-flight': '#fbbf24',
  unlinked: '#64748b',
};

export default function ShipStatusPill({ value }: { value: ShipStatus | null }) {
  if (value === null) {
    return (
      <span title="Session has commits but PR data not fetched. Run `cet sync --pr`."
        style={{ color: '#64748b', fontSize: '0.85em' }}>
        (no PR data)
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: '0.75em',
        fontWeight: 600,
        background: COLORS[value] + '22',
        color: COLORS[value],
      }}
    >
      {LABELS[value]}
    </span>
  );
}
