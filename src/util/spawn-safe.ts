import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

const WINDOWS_EXECUTABLE_EXTENSION = /\.(exe|cmd|bat|ps1)$/i;
const PATH_SEPARATOR = /[\\/]/;

/**
 * Safer spawn wrapper. On Windows, resolves bare command names like `npm`
 * to their `.cmd` shim without enabling shell interpolation. Paths
 * (anything containing `/` or `\`) and commands with an explicit Windows
 * executable extension pass through untouched.
 */
export function spawnSafe(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const isBareCommand = !PATH_SEPARATOR.test(command);
  const needsCmdShim =
    process.platform === 'win32' &&
    isBareCommand &&
    !WINDOWS_EXECUTABLE_EXTENSION.test(command);

  if (needsCmdShim) {
    return spawn(`${command}.cmd`, [...args], options);
  }

  return spawn(command, [...args], options);
}
