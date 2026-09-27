// run_command: one-shot foreground commands, cwd-locked to the workspace. The
// process itself comes from the executor (src/harness/executor.ts), shared by
// the four surfaces that run project commands; this module keeps the
// run_command entry points and the text projection shown to the model.

import { CommandResult, Executor, hostExecutor } from "../harness/executor";
import { CommandLogs, shortenLog } from "./command-log";

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

/** Comment rendre un résultat au modèle (#19) : la place disponible, et où
 * garder le journal complet d'une sortie raccourcie. Absents : 8 000
 * caractères, aucun journal gardé. */
export interface RenderOptions {
  maxChars?: number;
  logs?: CommandLogs;
}

/** Projection texte montrée au modèle. Une sortie qui tient est rendue au
 * format historique, inchangé. Une sortie trop longue garde son début et sa
 * fin ; après un échec, les lignes décisives de la partie omise remontent en
 * tête, et le journal complet est gardé sous `log:<n>` pour une lecture
 * ciblée (#19). Le code de sortie reste celui du système. */
export function renderCommandResult(result: CommandResult, opts: RenderOptions = {}): string {
  const full = result.log ?? result.output;
  const budget = Math.max(400, Math.min(OUTPUT_CAP, Math.floor(opts.maxChars ?? OUTPUT_CAP)));
  const failed = !(result.status === "exited" && result.exitCode === 0);
  const view = shortenLog(full, budget, failed);
  let where = "";
  if (view.shortened && opts.logs) {
    const ref = opts.logs.add(full);
    const lines = full.split("\n").length;
    const offset = view.focus ? Math.max(1, view.focus - 5) : 1;
    where = `\n[full output: ${lines} lines, kept as "${ref}". ${view.focus ? "To see the failure in context" : "To read any part"}: read_file {"path": "${ref}", "offset": ${offset}}]`;
  }
  switch (result.status) {
    case "spawn_error":
      return `Error: could not start command: ${result.error}`;
    case "cancelled":
      if (!result.started) return "Error: command cancelled before starting";
      return (full.trim() ? view.text + where + "\n" : "") +
        "[command cancelled by the user before it finished]";
    case "timeout":
      return "Error: " + view.text + where +
        `\n[command timed out after ${(result.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s and was killed. For tests/builds, isolate the stuck test or phase and inspect its loop or initialization before rerunning. For a persistent dev server, use task {"action": "start"}.]`;
    default: {
      const code = result.exitCode ?? "?";
      const secs = (result.durationMs / 1000).toFixed(1);
      const body = full.trim() ? view.text + where : "(no output)";
      return `${result.exitCode !== 0 ? `Error: command exited with code ${code}\n` : ""}${body}\n[exit code ${code} in ${secs}s]`;
    }
  }
}

export async function runCommand(command: string, cwd: string, signal?: AbortSignal, exec?: ExecOptions, executor?: Executor, view?: RenderOptions): Promise<string> {
  return renderCommandResult(await runCommandResult(command, cwd, signal, DEFAULT_TIMEOUT_MS, exec, executor), view);
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
