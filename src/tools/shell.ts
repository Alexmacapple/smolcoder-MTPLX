// run_command: one-shot foreground commands, cwd-locked to the workspace. The
// process itself comes from the executor (src/harness/executor.ts), shared by
// the four surfaces that run project commands; this module keeps the
// run_command entry points and the text projection shown to the model.

import { CommandResult, Executor, hostExecutor } from "../harness/executor";
import { truncateMiddle } from "../util";

// Le lancement vit dans l'exécuteur ; ces noms restent importables d'ici.
export { killTree, pickShell } from "../harness/executor";
export type { CommandResult } from "../harness/executor";

/** Contexte d'exécution imposé par la politique du profil mission : un
 * environnement minimal explicite et un shell sans profil de connexion.
 * Absent = comportement courant (environnement entier, shell de connexion). */
export interface ExecOptions {
  env: NodeJS.ProcessEnv;
  login: boolean;
}

const OUTPUT_CAP = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Seul un processus sorti de lui-même avec le code 0 réussit. */
export function commandPassed(result: CommandResult): boolean {
  return result.status === "exited" && result.exitCode === 0;
}

/** Projection texte montrée au modèle : format historique inchangé. */
export function renderCommandResult(result: CommandResult): string {
  const { output } = result;
  switch (result.status) {
    case "spawn_error":
      return `Error: could not start command: ${result.error}`;
    case "cancelled":
      if (!result.started) return "Error: command cancelled before starting";
      return (output.trim() ? truncateMiddle(output, OUTPUT_CAP) + "\n" : "") +
        "[command cancelled by the user before it finished]";
    case "timeout":
      return "Error: " + truncateMiddle(output, OUTPUT_CAP) +
        `\n[command timed out after ${(result.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s and was killed. For tests/builds, isolate the stuck test or phase and inspect its loop or initialization before rerunning. For a persistent dev server, use task {"action": "start"}.]`;
    default: {
      const code = result.exitCode ?? "?";
      const secs = (result.durationMs / 1000).toFixed(1);
      const body = output.trim() ? truncateMiddle(output, OUTPUT_CAP) : "(no output)";
      return `${result.exitCode !== 0 ? `Error: command exited with code ${code}\n` : ""}${body}\n[exit code ${code} in ${secs}s]`;
    }
  }
}

export async function runCommand(command: string, cwd: string, signal?: AbortSignal, exec?: ExecOptions, executor?: Executor): Promise<string> {
  return renderCommandResult(await runCommandResult(command, cwd, signal, DEFAULT_TIMEOUT_MS, exec, executor));
}

/** `executor` : la couture d'exécution, l'adaptateur hôte par défaut.
 * `surface` : "check" pour les vérifications automatiques. */
export function runCommandResult(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  exec?: ExecOptions,
  executor: Executor = hostExecutor,
  surface: "command" | "check" = "command"
): Promise<CommandResult> {
  // Une exception du lancement devient un rejet de la promesse, comme avant.
  return new Promise((resolve) => resolve(executor.start({
    surface,
    command,
    cwd,
    env: exec?.env ?? process.env,
    login: exec?.login ?? true,
    timeoutMs,
    signal,
    capture: "buffer",
  }).result));
}
