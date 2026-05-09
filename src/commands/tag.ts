/**
 * CLI tag command handler.
 *
 * Tags sessions with labels for filtering and organization.
 * Tags are stored as comma-separated values.
 */

import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';

interface TagOptions {
  dataDir?: string;
  session: string;
  tags?: string;
  remove?: boolean;
  list?: boolean;
}

export async function handleTag(opts: TagOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  ensureInitialized(dataDir);

  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: ' + err.message);
      process.exit(1);
    }
    throw err;
  }

  try {
    const db = storage.db;

    const session = db.prepare('SELECT id, tags FROM sessions WHERE id = ?').get(opts.session) as { id: string; tags: string | null } | undefined;
    if (!session) {
      console.error(`Error: Session not found: ${opts.session}`);
      console.error('Use "cet report --json" to list available session IDs.');
      process.exit(1);
    }

    if (opts.list) {
      const currentTags = session.tags ? session.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      if (currentTags.length === 0) {
        console.log(`Session ${session.id}: no tags`);
      } else {
        console.log(`Session ${session.id} tags: ${currentTags.join(', ')}`);
      }
      return;
    }

    const currentTags = session.tags ? session.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (opts.remove) {
      if (!opts.tags) {
        console.error('Error: --tags required with --remove.');
        process.exit(1);
      }
      const toRemove = new Set(opts.tags.split(',').map(t => t.trim().toLowerCase()));
      const remaining = currentTags.filter(t => !toRemove.has(t.toLowerCase()));
      const newTags = remaining.length > 0 ? remaining.join(', ') : null;
      db.prepare('UPDATE sessions SET tags = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newTags, opts.session);
      console.log(`Removed tags from session ${session.id}: ${remaining.length > 0 ? remaining.join(', ') : '(all removed)'}`);
    } else {
      if (!opts.tags) {
        console.error('Error: --tags required (use comma-separated values).');
        console.error('Usage: cet tag --session <id> --tags "exploratory,feature"');
        console.error('       cet tag --session <id> --tags "bugfix" --remove');
        console.error('       cet tag --session <id> --list');
        process.exit(1);
      }
      const newTagList = opts.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      const merged = [...new Set([...currentTags, ...newTagList])];
      const newTags = merged.join(', ');
      db.prepare('UPDATE sessions SET tags = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newTags, opts.session);
      console.log(`Tagged session ${session.id}: ${newTags}`);
    }
  } finally {
    storage.close();
  }
}
