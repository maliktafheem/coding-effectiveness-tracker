import { renameSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir, ensureDataDir, isInitialized } from "../config.js";
import { Storage, StorageError } from "../storage.js";

interface InitOptions {
  dataDir?: string;
  force?: boolean;
}

export async function handleInit(opts: InitOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const alreadyInit = isInitialized(dataDir);

  if (alreadyInit && !opts.force) {
    console.log(`Already initialized at: ${dataDir}`);
    console.log("Use --force to reinitialize.");
    return;
  }

  ensureDataDir(dataDir);

  if (alreadyInit && opts.force) {
    console.log(`Reinitializing at: ${dataDir}`);
  }

  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir, allowCorrupt: !!opts.force });
  } catch (err) {
    if (err instanceof StorageError && opts.force && (err.code === "DB_OPEN_FAILED" || err.code === "DB_CORRUPT")) {
      // Move the corrupt database aside and retry
      storage?.close();
      const corruptPath = join(dataDir, "tracker.db");
      const backupName = `tracker.db.corrupt.${Date.now()}`;
      const backupPath = join(dataDir, backupName);
      try {
        renameSync(corruptPath, backupPath);
        console.log(`Moved corrupt database to: ${backupName}`);
      } catch (moveErr) {
        const moveMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
        console.error(`Error: Failed to move corrupt database: ${moveMessage}`);
        process.exit(1);
      }
      // Retry opening - now with no existing corrupt file
      storage = Storage.open({ dataDir });
    } else if (err instanceof StorageError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } else {
      throw err;
    }
  }

  try {
    // Insert default tool records if not present
    const defaultTools = [
      { id: "codex", name: "codex", display_name: "Codex" },
      { id: "opencode", name: "opencode", display_name: "OpenCode" },
      { id: "factory-droid", name: "factory-droid", display_name: "Factory Droid" },
      { id: "claude-code", name: "claude-code", display_name: "Claude Code" },
      { id: "cursor", name: "cursor", display_name: "Cursor" },
    ];

    const db = storage.db;
    const insertTool = db.prepare(
      "INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)",
    );

    const insertAll = db.transaction(() => {
      for (const tool of defaultTools) {
        insertTool.run(tool.id, tool.name, tool.display_name);
      }
    });
    insertAll();

    console.log(`Initialized workspace at: ${dataDir}`);
    console.log(`Database: ${storage.dbPath}`);
    console.log("Registered AI tools: Codex, OpenCode, Factory Droid, Claude Code, Cursor");
    console.log("Privacy: All data stays local. No telemetry or external services.");
  } catch (err) {
    if (err instanceof StorageError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    storage?.close();
  }
}
