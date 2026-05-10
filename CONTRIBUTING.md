# Contributing

Thank you for considering contributing to the Coding Effectiveness Tracker. This document outlines the setup process, testing workflow, pull request procedure, and commit conventions.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Project Structure](#project-structure)
- [Running Tests](#running-tests)
- [Code Quality](#code-quality)
- [Pull Request Process](#pull-request-process)
- [Conventional Commits](#conventional-commits)
- [Reporting Issues](#reporting-issues)

## Prerequisites

- **Node.js** 20 or newer
- **npm** (bundled with Node.js)
- **Git** for version control and commit history syncing

## Setup

1. Fork and clone the repository:

   ```powershell
   git clone https://github.com/maliktafheem/coding-effectiveness-tracker.git
   cd coding-effectiveness-tracker
   ```

2. Install dependencies:

   ```powershell
   npm install
   ```

3. Build the project:

   ```powershell
   npm run build
   ```

4. Verify the setup with a quick initialization:

   ```powershell
   npm run dev -- init
   ```

## Project Structure

```
coding-effectiveness-tracker/
├── bin/                    # CLI entry point
├── src/
│   ├── cli.ts              # CLI command definitions (Commander)
│   ├── commands/           # Command implementations
│   │   ├── import.ts       # Import tool sessions
│   │   ├── init.ts         # Initialize workspace
│   │   ├── sync.ts         # Git commit sync
│   │   ├── test-outcome.ts # Test result ingestion
│   │   ├── annotate.ts     # Manual annotations
│   │   ├── report.ts       # Effectiveness reports
│   │   ├── serve.ts        # Dashboard/API server
│   │   └── export.ts       # Report export
│   ├── importers/          # Tool-specific importers
│   ├── collectors/         # Data collectors (git, test)
│   ├── correlation/        # Session correlation engine
│   ├── scoring/            # Effectiveness scoring
│   ├── storage.ts          # SQLite database layer
│   ├── api/                # Fastify API server
│   └── dashboard/          # Vite/React dashboard
├── tests/                  # Test suites
├── docs/                   # Documentation
└── package.json
```

## Running Tests

Run the full test suite:

```powershell
npm test
```

Run tests in watch mode during development:

```powershell
npm run test:watch
```

Run only e2e tests:

```powershell
npm run test:e2e
```

Run a specific test file:

```powershell
npx vitest run tests/helpers.test.ts
```

### Writing Tests

- Tests live in the `tests/` directory and use **Vitest**.
- Test files follow the naming convention `*.test.ts`.
- Unit tests cover individual modules; e2e tests cover the full CLI workflow.
- When adding a new feature, include tests for success paths, error handling, and edge cases.

## Code Quality

Before submitting changes, ensure the following pass:

```powershell
# TypeScript type checking
npm run typecheck

# Linting (ESLint)
npm run lint

# Full test suite
npm test

# Build
npm run build
```

All four commands must exit with code 0.

## Pull Request Process

1. **Create a feature branch** from `master`:

   ```powershell
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes** following the coding conventions outlined below.

3. **Write or update tests** to cover your changes.

4. **Run all quality checks** (typecheck, lint, test, build).

5. **Commit your changes** using [conventional commits](#conventional-commits).

6. **Push your branch** and open a pull request against `master`.

7. **Fill out the pull request template** completely, including the checklist for tests, documentation, and changelog.

8. **Wait for review** — address any feedback and update your PR as needed.

### Before Merging

- All CI checks must pass.
- At least one maintainer review is required.
- The branch must be up-to-date with `master`.

## Conventional Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for commit messages. The format is:

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

### Types

| Type     | Description                                      |
|----------|--------------------------------------------------|
| `feat`   | A new feature                                    |
| `fix`    | A bug fix                                        |
| `docs`   | Documentation-only changes                       |
| `style`  | Code style changes (formatting, semicolons, etc.) |
| `refactor` | Code changes that neither fix a bug nor add a feature |
| `test`   | Adding or updating tests                         |
| `chore`  | Build process, dependencies, tooling changes      |
| `perf`   | Performance improvements                         |

### Scope

The scope is optional but encouraged. Examples: `cli`, `import`, `sync`, `api`, `dashboard`, `docs`, `deps`.

### Examples

```
feat(import): add Claude Code importer
fix(sync): handle detached HEAD state
docs: add API reference for export endpoints
chore(deps): update vitest to v4
```

## Reporting Issues

Please use the [issue templates](.github/ISSUE_TEMPLATE/) when reporting bugs or requesting features. This helps us triage and respond more efficiently.
