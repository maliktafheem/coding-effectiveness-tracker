# docs/

This directory contains the reference documentation for the Coding Effectiveness Tracker (CET). Each file is a self-contained reference — no external context required.

## File Index

| File | Covers |
|------|--------|
| [architecture.md](architecture.md) | System components, data flow, dependency graph, key design patterns |
| [development.md](development.md) | Prerequisites, build/test, project structure, cross-platform notes |
| [cli-reference.md](cli-reference.md) | All 15 CLI commands with options, flags, and usage examples |
| [api-reference.md](api-reference.md) | All 14 API endpoints with query parameters and response shapes |
| [data-model.md](data-model.md) | All 10 database tables, columns, indexes, and relationships |
| [scoring.md](scoring.md) | Effectiveness dimensions, weights, thresholds, ship rate, prompt quality |
| [importer-guide.md](importer-guide.md) | ToolImporter interface, canHandle/parse, registration, privacy, path safety |
| [privacy.md](privacy.md) | Local-first architecture, no telemetry, loopback-only, redaction pipeline, canary testing |
| [plugins.md](plugins.md) | Custom importer plugins: location, format, required methods, loading |

## Quick Links

- **CLI entry point**: `cet` (bin/cli.js)
- **Default data directory**: `%LOCALAPPDATA%\coding-effectiveness-tracker` (Windows) / `~/.coding-effectiveness-tracker` (macOS/Linux)
- **Default dashboard port**: `43187` (loopback only)
- **License**: MIT
- **Minimum Node**: 20+
