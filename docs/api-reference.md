# API Reference

The API server is started via `cet serve` and binds to `127.0.0.1` only (loopback). Default port is `43187`.

Base URL: `http://127.0.0.1:<port>`

All endpoints return JSON unless noted otherwise.

## Common Query Parameters

The following optional parameters can be appended to most GET endpoints for filtering:

| Parameter | Type | Description |
|-----------|------|-------------|
| `tool` | string | Filter by source tool id (e.g., `codex`, `claude-code`) |
| `project` | string | Filter by project id |
| `from` | string | Start date (ISO 8601 date `YYYY-MM-DD` or datetime `YYYY-MM-DDTHH:mm:ssZ`) |
| `to` | string | End date (ISO 8601 date `YYYY-MM-DD` or datetime `YYYY-MM-DDTHH:mm:ssZ`) |
| `raw` | boolean | Include raw session metadata in exports (`true`/`false`) |

Date-only values (e.g., `from=2025-01-01`) are expanded to `T00:00:00Z` / `T23:59:59Z`.

All error responses use the shape `{ "error": string }`.

---

## `GET /health`

Health check endpoint. Returns server status and timestamp.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

---

## `GET /api/available-tools`

Get all registered source tools with their session counts. Used to populate tool filter dropdowns.

**Response:**
```json
{
  "tools": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "sessionCount": 30
    },
    {
      "id": "codex",
      "name": "Codex",
      "sessionCount": 17
    }
  ]
}
```

**Returns empty array** (`{ "tools": [] }`) if workspace is not initialized.

---

## `GET /api/overview`

Aggregate overview of sessions with effectiveness score.

**Query parameters:** `tool`, `project`, `from`, `to`

**Response (non-empty):**
```json
{
  "totalSessions": 47,
  "tools": ["codex", "claude-code"],
  "dateRange": {
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-03-15T12:30:00.000Z"
  },
  "outcomeCount": 12,
  "score": {
    "aggregate": 0.72,
    "dimensions": [
      {
        "name": "activity-output",
        "value": 1,
        "weight": 0.15,
        "explanation": "47 AI session(s) completed in the selected period.",
        "available": true
      }
    ],
    "missingInputs": [
      "Test outcome data not available for tool 'claude-code'"
    ]
  },
  "empty": false
}
```

**Response (empty — no sessions):**
```json
{
  "totalSessions": 0,
  "tools": [],
  "dateRange": { "from": null, "to": null },
  "outcomeCount": 0,
  "score": {
    "aggregate": 0,
    "dimensions": [],
    "missingInputs": ["No sessions available."]
  },
  "empty": true,
  "message": "No sessions found. Import data with: cet import --fixture <path>"
}
```

**Error:** Returns `503` if workspace is not initialized.

---

## `GET /api/timeline`

Get all sessions with correlation and outcome summaries for timeline display.

**Query parameters:** `tool`, `project`, `from`, `to`

**Response:**
```json
{
  "sessions": [
    {
      "id": "uuid-string",
      "sourceToolId": "codex",
      "projectId": "my-app",
      "externalId": "ext-session-1",
      "startedAt": "2025-01-15T10:00:00.000Z",
      "endedAt": "2025-01-15T11:30:00.000Z",
      "durationMs": 5400000,
      "summary": "Implement user authentication flow",
      "model": "claude-sonnet-4-20250514",
      "correlationCount": 3,
      "outcomeCount": 1,
      "outcomeLabels": ["shipped"],
      "hasOutcome": true,
      "reworkCount": 0
    }
  ],
  "total": 47
}
```

**Returns empty object** (no sessions) if workspace is not initialized.

---

## `GET /api/tools`

Get tool-level breakdown with per-tool session counts, outcome counts, and scores.

**Query parameters:** `tool`, `project`, `from`, `to`

**Response:**
```json
{
  "tools": [
    {
      "toolId": "codex",
      "sessionCount": 30,
      "outcomeCount": 8,
      "score": 0.75
    },
    {
      "toolId": "claude-code",
      "sessionCount": 17,
      "outcomeCount": 4,
      "score": 0.68
    }
  ]
}
```

**Returns empty array** if workspace is not initialized.

---

## `GET /api/projects`

Get project-level breakdown with session counts.

**Response:**
```json
{
  "projects": [
    {
      "projectId": "my-app",
      "sessionCount": 30
    },
    {
      "projectId": "another-project",
      "sessionCount": 17
    }
  ]
}
```

**Returns empty array** if workspace is not initialized.

---

## `GET /api/trends`

Get weekly trend data for sessions, test results, and effectiveness scores.

**Query parameters:** `project`

**Response:**
```json
{
  "points": [
    {
      "weekStart": "2025-01-06T00:00:00.000Z",
      "weekEnd": "2025-01-12T23:59:59.000Z",
      "sessionCount": 12,
      "sessionsWithGit": 8,
      "totalTestsPassed": 45,
      "totalTestsFailed": 3,
      "scoreAggregate": 0.74
    }
  ],
  "period": {
    "from": "2025-01-06T00:00:00.000Z",
    "to": "2025-03-15T23:59:59.000Z"
  }
}
```

**Returns empty points array** (`{ "points": [], "period": { "from": null, "to": null } }`) if workspace is not initialized.

---

## `GET /api/sessions/:id`

Get detailed session information including correlations, outcomes, and metadata.

**Path parameters:** `id` — Session UUID

**Response:**
```json
{
  "id": "uuid-string",
  "sourceToolId": "codex",
  "projectId": "my-app",
  "externalId": "ext-session-1",
  "startedAt": "2025-01-15T10:00:00.000Z",
  "endedAt": "2025-01-15T11:30:00.000Z",
  "durationMs": 5400000,
  "summary": "Implement user authentication flow",
  "model": "claude-sonnet-4-20250514",
  "tokensInput": 15000,
  "tokensOutput": 4500,
  "costEstimate": 0.05,
  "metadata": { "messageCount": 12, "reworkCount": 0 },
  "reworkCount": 0,
  "correlations": [
    {
      "id": "corr-uuid",
      "type": "git-commit",
      "targetId": "commit-uuid",
      "confidence": 0.85,
      "reasons": ["commit timestamp within session window", "same project"]
    }
  ],
  "outcomes": [
    {
      "id": "outcome-uuid",
      "type": "manual",
      "label": "shipped",
      "score": 1,
      "note": "Merged with tests passing"
    }
  ],
  "uncorrelated": false
}
```

**Errors:**
- `404` — Session not found
- `503` — Workspace not initialized

---

## `POST /api/sessions/:id/annotations`

Record a manual outcome annotation for a session.

**Path parameters:** `id` — Session UUID

**Request body (JSON):**
```json
{
  "outcome": "shipped",
  "score": 1,
  "note": "Merged with tests passing",
  "tags": ["feature", "auth"]
}
```

**Validation:**
- `outcome` (required): Must be a non-empty string matching one of: `good`, `accepted`, `merged`, `shipped`, `ok`, `neutral`, `partial`, `poor`, `rejected`, `reverted`, `abandoned`, `unknown`
- `score` (optional): Must be a number between 0 and 1
- `note` (optional): Free-text string
- `tags` (optional): Array or comma-separated string

**Response (201):**
```json
{
  "id": "new-annotation-uuid",
  "sessionId": "session-uuid",
  "outcome": "shipped",
  "score": 1,
  "note": "Merged with tests passing",
  "createdAt": "2025-01-15T12:00:00.000Z"
}
```

**Errors:**
- `400` — Invalid outcome, missing outcome, or score out of range
- `404` — Session not found
- `503` — Workspace not initialized

---

## `PATCH /api/annotations/:id`

Update an existing annotation.

**Path parameters:** `id` — Annotation UUID

**Request body (JSON):**
```json
{
  "outcome": "shipped",
  "score": 0.9,
  "note": "Updated: merged with minor fixes"
}
```

**Validation:** Same rules as POST annotations. All fields are optional (only provided fields are updated).

**Response:**
```json
{
  "id": "annotation-uuid",
  "sessionId": "session-uuid",
  "outcome": "shipped",
  "score": 0.9,
  "note": "Updated: merged with minor fixes"
}
```

**Errors:**
- `400` — Invalid outcome or score out of range
- `404` — Annotation not found
- `503` — Workspace not initialized

---

## `GET /api/export/json`

Export full report data as JSON.

**Query parameters:** `tool`, `project`, `from`, `to`, `raw`

When `raw=true`, includes full session metadata (otherwise metadata is excluded for privacy).

**Response:**
```json
{
  "score": {
    "aggregate": 0.72,
    "dimensions": [...],
    "missingInputs": [...]
  },
  "sessions": [
    {
      "id": "uuid",
      "sourceToolId": "codex",
      "projectId": "my-app",
      "startedAt": "2025-01-15T10:00:00.000Z",
      "endedAt": "2025-01-15T11:30:00.000Z",
      "durationMs": 5400000,
      "summary": "Implement user authentication flow",
      "model": "claude-sonnet-4-20250514",
      "tokensInput": 15000,
      "tokensOutput": 4500,
      "costEstimate": 0.05,
      "correlations": [...],
      "outcomes": [...],
      "reworkCount": 0
    }
  ],
  "tools": ["codex", "claude-code"],
  "totalSessions": 47,
  "period": {
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-03-15T12:30:00.000Z"
  },
  "empty": false,
  "generatedAt": "2025-01-15T12:00:00.000Z"
}
```

**Response — empty:**
```json
{
  "score": { "aggregate": 0, "dimensions": [], "missingInputs": ["No sessions available."] },
  "sessions": [],
  "tools": [],
  "totalSessions": 0,
  "period": { "from": null, "to": null },
  "empty": true,
  "generatedAt": "2025-01-15T12:00:00.000Z"
}
```

---

## `GET /api/export/markdown`

Export full report data as Markdown. Returns content type `text/markdown`.

**Query parameters:** `tool`, `project`, `from`, `to`, `raw`

**Response:** A Markdown document with:
- Overview section (total sessions, tools, period, effectiveness score)
- Score dimensions table
- Tool comparison table
- Per-session details with correlations and outcomes
- Privacy footer
