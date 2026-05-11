# Effectiveness Scoring

Coding Effectiveness Tracker computes a **balanced aggregate score** from six dimensions. Each dimension contributes a weighted value between 0 and 1. All dimensions contribute to the denominator; dimensions without data contribute 0 to the numerator (rather than being dropped from the denominator, which would inflate the aggregate). The score includes a `dataCompleteness` fraction and `evidenceLevel` label so you can tell at a glance how trustworthy it is.

## Dimensions

### 1. Activity / Output (weight: 0.15)

Measures how many AI coding sessions were completed in the selected period. Reaches 100% at the configured `activitySessionCap` sessions (default: 10).

```
activity = min(sessionCount / activitySessionCap, 1)
```

**Available when:** at least one session exists.

### 2. Git Correlation (weight: 0.25)

Measures what fraction of sessions correlate with local git commits via time-overlap matching, **weighted by correlation confidence**. A high-confidence direct match counts fully; a low-confidence timestamp coincidence is ignored.

```
gitScore = sum(min(maxConfidence, 1) for qualifying sessions) / totalSessions
```

- Correlations with `confidence < 0.3` are discarded entirely (too weak to credit).
- Confidence itself is additive per match: +0.5 for exact time overlap, +0.2 for proximity bonus, +0.3 when session and commit share the same project. A +0.1 "same branch" bonus fires only when all correlated commits share a **non-default** feature branch (integration branches `master`/`main`/`develop`/`trunk` are excluded).

**Available when:** at least one session has a git-commit correlation at or above the confidence threshold.

### 3. Test Confidence (weight: 0.25)

Combines test pass rate with session-test correlation ratio, **scoped to outcomes linked to the filtered sessions**. Project-wide test outcomes that aren't tied to a session (directly via `session_id` or via a `test-outcome` correlation row) are ignored so green CI runs don't inflate unrelated AI sessions.

```
passRate = totalPassed / (totalPassed + totalFailed)
correlationRatio = sum(min(maxConfidence, 1) for qualifying sessions) / totalSessions
testScore = passRate * 0.6 + correlationRatio * 0.4
```

Low-confidence correlations (< 0.3) are discarded from the ratio.

**Available when:** at least one test outcome is linked to one of the filtered sessions.

> **Note:** Test outcome correlation is temporal, not causal. The score reflects that tests commonly run after or near coding sessions. It does not prove the AI session caused the test results.

### 4. Manual Outcome (weight: 0.15)

Average of user-assigned outcome scores (0–1) from `cet annotate`. These are explicit user judgments about session effectiveness.

**Available when:** at least one manual annotation with a numeric score exists.

### 5. Cost Efficiency (weight: 0.10)

Derived from cost and token data when available from AI tools. Higher costs relative to sessions reduce the score.

```
costScore = 1 - min(avgCostPerSession / costCeiling, 1)
```

**Available when:** cost data exists on at least one session.

### 6. Rework Indicator (weight: 0.10)

Measures how many sessions involved retry or rework attempts. Fewer rework sessions produce a higher score.

```
reworkRatio = sessionsWithRework / totalSessions
reworkScore = 1 - reworkRatio
```

The dimension is computed via a single SQLite aggregate (`json_extract` on `metadata_json.reworkCount`). Sessions whose `metadata_json` fails `json_valid` are counted separately and surfaced in the explanation.

**Available when:** at least one session's metadata parses (regardless of whether it contains a rework signal). A mixed batch with some malformed metadata still produces a score from the valid sessions and notes the malformed count in the explanation. The dimension is only reported **unavailable** when *every* session's metadata fails to parse — in that case the explanation reads "rework signal unavailable" rather than silently scoring 1.0.

---

## Aggregate Score

All dimensions contribute to the denominator; unavailable dimensions contribute 0 to the numerator. This prevents a project with only activity and rework data from scoring ~100% by excluding missing dimensions from the denominator.

```
aggregate = sum(availableValue × weight) / sum(allWeights)
```

Missing dimensions are reported in the output as "Missing/Partial Inputs" — not as zero scores.

## Evidence level and completeness

The score includes a `dataCompleteness` fraction (0..1) and an `evidenceLevel` label alongside the aggregate. These tell you how trustworthy the aggregate number is.

```
dataCompleteness = sum(availableWeights) / sum(allWeights)
```

Three evidence levels:

- **`insufficient`** — Either no objective dimension (git correlation, test confidence, manual outcome, or PR outcome) has data, or `dataCompleteness` is below 0.4. The aggregate number should not be taken at face value; add more data sources before relying on it.
- **`partial`** — At least one objective dimension has data, and completeness is between 0.4 and 0.7. The aggregate is directional but may shift significantly as more signals arrive.
- **`strong`** — Completeness is 0.7 or higher with at least one objective dimension. The aggregate is a trustworthy measure of coding effectiveness.

In the UI and CLI report, the evidence level is displayed as a colored pill (red / amber / green) or text. When `insufficient`, a banner is shown recommending the user add git correlation, tests, or annotations.

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
- **Format:** JSON object with a `"weights"` key and optional `"thresholds"` key
- **Unspecified weights:** Fall back to defaults
- **Validation:** Weights must be numbers between 0 and 1. Invalid config falls back to defaults with a warning
- **Normalization:** Weights are normalized to sum to 1.0
- **Thresholds:** `activitySessionCap` controls the session count that reaches 100% activity score (default: 10). `costCeiling` controls the per-session cost that reaches 0% cost efficiency (default: 1.0 dollars)

Example with thresholds:

```json
{
  "weights": {
    "git-correlation": 0.30,
    "test-confidence": 0.30
  },
  "thresholds": {
    "activitySessionCap": 20,
    "costCeiling": 2.0
  }
}
```

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
- The rework indicator only captures metadata-based retry counts. If a tool does not expose rework metadata, the dimension reports "no rework detected" rather than "unknown." Sessions with malformed `metadata_json` are excluded from the signal and surfaced in the explanation; the dimension is only reported unavailable when *all* sessions have unparseable metadata.
- Correlation and rework queries use SQLite's `json_each` and `json_extract` to aggregate over filtered session sets in a single pass — no per-session loops.

---

## Ship Rate (opt-in, v0.2)

Session-level ship status is derived from correlations with GitHub PRs.

Values:
- `shipped` — Merged PR, not later reverted
- `reverted` — Merged then later reverted PR
- `abandoned` — Closed unmerged PR
- `in-flight` — Open PR
- `unlinked` — No matching commits found

To populate: run `cet sync --pr`. Requires the `gh` CLI installed and authenticated with GitHub.

**Opt-in scoring:** `shipRate` is NOT in the default weighted score. To enable, edit `scoring.json`:

```json
{
  "weights": {
    "shipRate": 0.10
  }
}
```

Default weight is 0. Adding this weight rescales existing weights (users should manually rebalance). No code currently reads this weight — it is reserved for a future release.

---

## Prompt quality (v0.2)

Heuristic score 0-1 based on the first user prompt in a session.

Signals:
- **specificity** — Word count of the prompt
- **iteration** — Number of assistant turns
- **hasCodeBlock** — Whether prompt contains a code block
- **hasExample** — Whether prompt contains an example
- **hasConstraint** — Whether prompt mentions constraints (performance, security, etc.)

Prompt quality is not part of the effectiveness score. It is a separate dimension you can inspect via the dashboard "Prompting" page or `cet prompt-quality`.

The scoring uses a pluggable `PromptAnalyzer` interface. The built-in `heuristic-v1` analyzer computes signals locally. Future releases may include LLM-based analyzers that provide richer evaluations.
