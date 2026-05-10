/**
 * Screenshot capture script for README.
 *
 * Boots the dashboard server against the seeded `docs/assets/.demo-data`
 * directory, navigates to each dashboard view with Playwright, and saves
 * four high-resolution PNGs under `docs/assets/`.
 *
 * Run: `tsx scripts/capture-screenshots.ts` (after `tsx scripts/seed-demo.ts`)
 *
 * Requirements: `playwright` installed as a devDependency and a chromium
 * browser available (run `npx playwright install chromium` if the first
 * launch complains about a missing browser). The script is user-run and not
 * part of CI.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';

const PROJECT_ROOT = resolve(process.cwd());
const DATA_DIR = resolve(PROJECT_ROOT, 'docs', 'assets', '.demo-data');
const ASSETS_DIR = resolve(PROJECT_ROOT, 'docs', 'assets');
const PORT = 43287;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Old screenshots that must be removed before capture so stale files can't
// shadow a failed run.
const STALE_FILES = [
  'screenshot-overview.png',
  'screenshot-Timeline.png',
  'screenshot-Tools.png',
  'screenshot-Prompting.png',
];

const OUTPUTS = {
  overview: resolve(ASSETS_DIR, 'screenshot-overview.png'),
  timeline: resolve(ASSETS_DIR, 'screenshot-timeline.png'),
  tools: resolve(ASSETS_DIR, 'screenshot-tools.png'),
  sessionDetail: resolve(ASSETS_DIR, 'screenshot-session-detail.png'),
  prompting: resolve(ASSETS_DIR, 'screenshot-prompting.png'),
};

async function waitForHealth(url: string, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`Health check returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Dashboard did not become healthy at ${url} within ${maxMs}ms: ${msg}`);
}

async function killServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  const pid = child.pid;
  if (pid == null) return;

  if (process.platform === 'win32') {
    // Kill whole process tree so the tsx child doesn't orphan the fastify proc.
    const fallback = (): void => {
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
    };

    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
    } catch {
      fallback();
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => { if (!settled) { settled = true; resolve(); } };

      killer.on('error', () => {
        // taskkill binary missing or spawn-level failure — fall back.
        fallback();
        settle();
      });
      killer.on('exit', (code) => {
        // Non-zero exit (e.g. process tree needs elevation) — fall back.
        if (code !== 0) fallback();
        settle();
      });
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
  }
}

async function captureScreenshots(): Promise<void> {
  // 1. Drop stale uppercase screenshots so we never ship an outdated file.
  for (const name of STALE_FILES) {
    const full = resolve(ASSETS_DIR, name);
    if (existsSync(full)) {
      try {
        unlinkSync(full);
        console.log(`Removed stale ${name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: could not remove ${name}: ${msg}`);
      }
    }
  }
  // Also remove the four target files from previous runs (PNG writers append
  // rather than truncate on some filesystems if the process is interrupted).
  for (const target of Object.values(OUTPUTS)) {
    if (existsSync(target)) {
      try { unlinkSync(target); } catch { /* ignore */ }
    }
  }

  if (!existsSync(DATA_DIR)) {
    throw new Error(
      `Demo data not found at ${DATA_DIR}. Run 'tsx scripts/seed-demo.ts' first.`,
    );
  }

  // 2. Spawn `cet serve` against the demo data. Route stdio to buffers so the
  //    parent console stays clean; we'll print server output only if serve
  //    dies before we're done.
  const serverArgs = [
    'dist/cli.js',
    'serve',
    '--data-dir', DATA_DIR,
    '--port', String(PORT),
  ];

  const child = spawn('node', serverArgs, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // detached:true on POSIX gives us a process group we can kill wholesale.
    // On Windows, detached combined with taskkill /T works cleanly for the
    // spawned tree.
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams;

  let serverStdout = '';
  let serverStderr = '';
  child.stdout.on('data', (chunk: Buffer) => { serverStdout += chunk.toString('utf-8'); });
  child.stderr.on('data', (chunk: Buffer) => { serverStderr += chunk.toString('utf-8'); });

  let earlyExit: Error | null = null;
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      earlyExit = new Error(
        `Server exited early with code ${code} (signal ${signal}).\n` +
        `stdout:\n${serverStdout}\nstderr:\n${serverStderr}`,
      );
    }
  });

  let browser: Browser | undefined;
  try {
    try {
      await waitForHealth(`${BASE_URL}/health`, 30_000);
    } catch (err) {
      if (earlyExit) throw earlyExit;
      console.error(`Server stdout so far:\n${serverStdout || '<empty>'}`);
      console.error(`Server stderr so far:\n${serverStderr || '<empty>'}`);
      throw err;
    }
    if (earlyExit) throw earlyExit;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1.5,
    });
    const page = await context.newPage();
    page.on('console', msg => console.log(`[browser ${msg.type()}]`, msg.text()));
    page.on('pageerror', err => console.log('[browser pageerror]', err.message));

    // --- Capture 1: Overview
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.getByText(/Effectiveness/i).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.card svg').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await sleep(1000);
    await page.screenshot({ path: OUTPUTS.overview, fullPage: true, type: 'png' });

    // --- Capture 2: Timeline — click the nav link so React state updates.
    await page.locator('.nav a:has-text("Timeline")').click();
    await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10_000 });
    await sleep(400);
    await page.screenshot({ path: OUTPUTS.timeline, fullPage: true, type: 'png' });

    // --- Capture 3: Tools
    await page.locator('.nav a:has-text("Tools")').click();
    await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10_000 });
    await sleep(400);
    await page.screenshot({ path: OUTPUTS.tools, fullPage: true, type: 'png' });

    // --- Capture 4: Session detail — back to Timeline, click first row.
    await page.locator('.nav a:has-text("Timeline")').click();
    await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10_000 });
    try {
      await page.locator('table tbody tr').first().click({ timeout: 3_000 });
      await page.locator('button:has-text("Back to Timeline")')
        .waitFor({ state: 'visible', timeout: 5_000 });
      await sleep(600);
      await page.screenshot({ path: OUTPUTS.sessionDetail, fullPage: true, type: 'png' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Skipping session-detail capture: ${msg}`);
    }

    // --- Capture 5: Prompting
    await page.locator('.nav a:has-text("Prompting")').click();
    await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10_000 });
    await sleep(400);
    await page.screenshot({ path: OUTPUTS.prompting, fullPage: true, type: 'png' });

    await context.close();
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    await killServer(child);
    // Give Windows a moment to release the port before returning.
    await sleep(300);
  }

  // Summary — byte sizes for easy "is this sane" check.
  console.log('');
  console.log('Captured screenshots:');
  for (const [name, file] of Object.entries(OUTPUTS)) {
    const size = existsSync(file) ? statSync(file).size : 0;
    console.log(`  ${name.padEnd(14)} ${file}  (${size.toLocaleString()} bytes)`);
  }
}

captureScreenshots().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error('Capture failed:', msg);
  process.exit(1);
});
