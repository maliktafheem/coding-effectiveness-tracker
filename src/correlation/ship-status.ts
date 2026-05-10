import type Database from 'better-sqlite3';

export type ShipStatus = 'shipped' | 'reverted' | 'abandoned' | 'in-flight' | 'unlinked';

interface Row {
  session_id: string;
  has_commit: number;
  has_merged: number;
  has_reverted: number;
  has_closed: number;
  has_open: number;
}

/**
 * Derive ship status for a batch of session IDs in one SQL query.
 * Priority: reverted > shipped > in-flight > abandoned > null (commits, no PR) > unlinked.
 */
export function deriveShipStatus(
  db: Database.Database,
  sessionIds: string[],
): Map<string, ShipStatus | null> {
  const result = new Map<string, ShipStatus | null>();
  if (sessionIds.length === 0) return result;

  const rows = db
    .prepare(
      `
      SELECT
        s.id AS session_id,
        MAX(CASE WHEN c.correlation_type = 'git-commit' THEN 1 ELSE 0 END) AS has_commit,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'merged'
                 AND COALESCE(json_extract(c.metadata_json, '$.reverted'), 0) = 0
            THEN 1 ELSE 0 END) AS has_merged,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'merged'
                 AND json_extract(c.metadata_json, '$.reverted') = 1
            THEN 1 ELSE 0 END) AS has_reverted,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'closed'
            THEN 1 ELSE 0 END) AS has_closed,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'open'
            THEN 1 ELSE 0 END) AS has_open
      FROM sessions s
      LEFT JOIN correlations c ON c.session_id = s.id
      WHERE s.id IN (SELECT value FROM json_each(?))
      GROUP BY s.id
      `,
    )
    .all(JSON.stringify(sessionIds)) as Row[];

  for (const row of rows) {
    let status: ShipStatus | null;
    if (row.has_reverted) status = 'reverted';
    else if (row.has_merged) status = 'shipped';
    else if (row.has_open) status = 'in-flight';
    else if (row.has_closed) status = 'abandoned';
    else if (row.has_commit) status = null;
    else status = 'unlinked';
    result.set(row.session_id, status);
  }

  for (const id of sessionIds) {
    if (!result.has(id)) result.set(id, 'unlinked');
  }
  return result;
}