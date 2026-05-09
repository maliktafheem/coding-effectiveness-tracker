# Custom Importer Plugins

Custom importer plugins let you add support for AI coding tools
that aren't included in the built-in importers. Plugins are loaded
from the `plugins/` directory inside your tracker data directory.

## Plugin Location

- **Windows:** `%LOCALAPPDATA%\coding-effectiveness-tracker\plugins\`
- **macOS / Linux:** `~/.coding-effectiveness-tracker/plugins/`

## Plugin Format

Each plugin is a single `.js` file that exports a class implementing
the `ToolImporter` interface:

```js
// my-tool.js — example custom importer plugin
export default class MyToolImporter {
  get toolId() { return 'my-tool'; }
  get displayName() { return 'My AI Tool'; }

  canHandle(sourcePath) {
    // Return true if this importer can parse the given path
    return sourcePath.endsWith('.mytool');
  }

  parse({ sourcePath }) {
    // Return { sessions: [...], errors: [...], warnings: [...] }
    return { sessions: [], errors: [], warnings: [] };
  }
}
```

## Required Methods

| Method | Returns | Purpose |
|--------|---------|---------|
| `toolId` | `string` | Unique tool identifier |
| `displayName` | `string` | Human-readable name |
| `canHandle(path)` | `boolean` | Whether this importer can parse the given path |
| `parse({ sourcePath })` | `ImportResult` | Parse and return normalized sessions |

## How Plugins Are Loaded

Plugins are loaded automatically when you run `cet import` or `cet setup`.
The tracker scans `<dataDir>/plugins/` for `.js` files, instantiates each
found importer class, and registers it alongside the built-in importers.

Failed plugins are skipped with a warning — they don't prevent normal
operation.

## Example: Adding a Custom Importer

```powershell
# Windows
mkdir %LOCALAPPDATA%\coding-effectiveness-tracker\plugins
echo "export default class MyImporter { ... }" > %LOCALAPPDATA%\coding-effectiveness-tracker\plugins\my-tool.js
cet import --discover
```

```bash
# macOS / Linux
mkdir -p ~/.coding-effectiveness-tracker/plugins
cat > ~/.coding-effectiveness-tracker/plugins/my-tool.js << 'EOF'
export default class MyImporter {
  get toolId() { return 'my-tool'; }
  get displayName() { return 'My AI Tool'; }
  canHandle(path) { return path.endsWith('.mytool'); }
  parse({ sourcePath }) {
    return { sessions: [], errors: [], warnings: [] };
  }
}
EOF
cet import --discover
```
