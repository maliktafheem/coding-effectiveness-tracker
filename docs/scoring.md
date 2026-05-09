# Effectiveness Scoring

Coding Effectiveness Tracker computes a **balanced aggregate score** from six dimensions. Each dimension contributes a weighted value between 0 and 1. Dimensions without available data are **excluded** from the weighted denominator — they do not depress the score as zero-valued entries.

## Dimensions

### 1. Activity / Output (weight: 0.15)

Measures how many AI coding sessions were completed in the selected period. Reaches 100% at 10 sessions or more.

```
activity = min(sessionCount / 10, 1)
```

**Available when:** at least one session exists.

### 2. Git Correlation (weight: 0.25)

Measures what percentage of sessions correlate with local git commits via time-overlap matching. Higher correlation suggests AI sessions produced committed work.

```
gitScore = correlatedSessions / totalSessions
```

Correlation confidence is additive: +0.5 for exact time overlap, +0.2 for proximity bonus, +0.3 if session and commit share the same project.

**Available when:** at least one session has git commit correlations.

### 3. Test Confidence (weight: 0.25)

Combines test pass rate with session-test correlation ratio. Shows whether AI-assisted sessions are validated by test outcomes.

```
passRate = totalPassed / (totalPassed + totalFailed)
correlationRatio = sessionsWithTests / totalSessions
testScore = passRate * 0.6 + correlationRatio * 0.4
```

**Available when:** test outcomes exist within the session time windows.

> **Note:** Test outcome correlation is temporal, not causal. The score reflects that tests commonly run after or near coding sessions. It does not prove the AI session caused the test results.

### 4. Manual Outcome (weight: 0.15)

Average of user-assigned outcome scores (0–1) from `cet annotate`. These are explicit user judgments about session effectiveness.

**Available when:** at least one manual annotation with a numeric score exists.

### 5. Cost Efficiency (weight: 0.10)

Derived from cost and token data when available from AI tools. Higher costs relative to sessions reduce the score.

```
costScore = 1 - min(avgCostPerSession / $1.00, 1)
```

**Available when:** cost data exists on at least one session.

### 6. Rework Indicator (weight: 0.10)

Measures how many sessions involved retry or rework attempts. Fewer rework sessions produce a higher score.

```
reworkRatio = sessionsWithRework / totalSessions
reworkScore = 1 - reworkRatio
```

**Available when:** at least one session has metadata.

---

## Aggregate Score

Only dimensions with available data contribute:

```
aggregate = sum(availableValue × weight) / sum(availableWeight)
```

Missing dimensions are reported in the output as "Missing/Partial Inputs" — not as zero scores.

---

## Configuring Weights

Create a `scoring.json` file in your tracker data directory to override default weights:

```json
{
  "weights": {
    "git-correlation": 0.30,
    "test-confidence": 0.30,
    "manual-outcome": 0.10
  }
}
```

- **Location:** `<data-dir>/scoring.json` (typically `~/.coding-effectiveness-tracker/scoring.json`)
- **Format:** JSON object with a `"weights"` key
- **Unspecified weights:** Fall back to defaults
- **Validation:** Weights must be numbers between 0 and 1. Invalid config falls back to defaults with a warning
- **Normalization:** Weights are normalized to sum to 1.0

### Windows

```powershell
# Create config in Windows
echo {"weights":{"git-correlation":0.30}} > %LOCALAPPDATA%\coding-effectiveness-tracker\scoring.json
```

### macOS / Linux

```bash
cat > ~/.coding-effectiveness-tracker/scoring.json << 'EOF'
{
  "weights": {
    "git-correlation": 0.30,
    "test-confidence": 0.30
  }
}
EOF
```

---

## Viewing Weights

You can see the effective scoring weights by running a report:

```bash
cet report --json | jq '.score.dimensions[] | {name, weight}'
```

The report output shows each dimension's **current weight** and explanation.

---

## Limitations

- The scoring model correlates data points that are **temporally related**, not causally linked. A high score does not guarantee AI effectiveness — it reflects the measurable signals available.
- Sessions without project assignments have broader correlation windows (not filtered by project), which may inflate git and test correlation scores.
- Missing token/cost data from some AI tools means the cost-efficiency dimension may be unavailable for those tools.
- The rework indicator only captures metadata-based retry counts. If a tool does not expose rework metadata, the dimension reports "no rework detected" rather than "unknown."
