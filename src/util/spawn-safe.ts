import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

const WINDOWS_EXECUTABLE_EXTENSION = /\.(exe|cmd|bat|ps1)$/i;

/**
 * Safer spawn wrapper. On Windows, resolves bare command names like `npm`
 * to their `.cmd` shim without enabling shell interpolation.
 */
export function spawnSafe(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (process.platform === 'win32' && !WINDOWS_EXECUTABLE_EXTENSION.test(command)) {
    return spawn(`${command}.cmd`, [...args], options);
  }

  return spawn(command, [...args], options);
}
