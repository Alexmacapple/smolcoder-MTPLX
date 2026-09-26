// run_command: one-shot foreground commands, cwd-locked to the workspace.
// Shell picking matters on Windows: local models emit POSIX commands, so we
// prefer Git Bash when it exists, skip WSL's System32 bash (different
// filesystem world), and fall back to PowerShell. The chosen shell is named in
// the system prompt so the model knows what dialect to write.

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { truncateMiddle } from "../util";

export interface ShellInfo {
  exe: string;
  /** `login` false : sans les fichiers de démarrage de l'utilisateur, qui
   * peuvent réexporter des secrets (profil mission). Vrai par défaut. */
  argsFor: (cmd: string, login?: boolean) => string[];
  label: string; // goes into the system prompt
}

/** Contexte d'exécution imposé par la politique du profil mission : un
 * environnement minimal explicite et un shell sans profil de connexion.
 * Absent = comportement courant (environnement entier, shell de connexion). */
export interface ExecOptions {
  env: NodeJS.ProcessEnv;
  login: boolean;
}

let cached: ShellInfo | null = null;

export function pickShell(): ShellInfo {
  if (cached) return cached;
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "bin", "bash.exe"),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        cached = { exe: p, argsFor: (cmd, login = true) => ["-o", "pipefail", login ? "-lc" : "-c", cmd], label: "bash (Git Bash)" };
        return cached;
      }
    }
    // any bash on PATH that is not WSL's System32 shim
    const where = spawnSync("where.exe", ["bash"], { encoding: "utf8" });
    if (where.status === 0) {
      const found = where.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((p) => p && !p.toLowerCase().includes("system32"));
      if (found) {
        cached = { exe: found, argsFor: (cmd, login = true) => ["-o", "pipefail", login ? "-lc" : "-c", cmd], label: "bash (Git Bash)" };
        return cached;
      }
    }
    cached = {
      exe: "powershell.exe",
      argsFor: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
      label: "PowerShell",
    };
    return cached;
  }
  const sh = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  cached = {
    exe: sh,
    argsFor: (cmd, login = true) => [...(sh.endsWith("/bash") ? ["-o", "pipefail"] : []), login ? "-lc" : "-c", cmd],
    label: path.basename(sh),
  };
  return cached;
}

export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const OUTPUT_CAP = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Keep bash alive while ordinary background jobs own its output pipes. On
 * Windows taskkill cannot find descendants after their shell has exited. */
export function managedCommand(shell: ShellInfo, command: string): string {
  return /(?:^|[\\/])bash(?:\.exe)?$/.test(shell.exe)
    ? `${command}\n__smol_command_status=$?\nwait\nexit "$__smol_command_status"`
    : command;
}

/** Issue d'une commande au premier plan, telle que l'observe le système. Les
 * décisions (acceptation, contrôles de progression) lisent ces champs, jamais
 * le texte affiché au modèle, qui n'en est qu'une projection. */
export interface CommandResult {
  /** Le processus a été créé (faux : annulé avant le lancement, ou échec du lancement). */
  started: boolean;
  status: "exited" | "signaled" | "timeout" | "cancelled" | "spawn_error";
  /** Code de sortie réel du processus ; null s'il n'est pas sorti de lui-même. */
  exitCode: number | null;
  /** Signal de terminaison rapporté par le système, le cas échéant. */
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** stdout et stderr mêlés, plafonnés en gardant le début et la fin. */
  output: string;
  /** Délai appliqué, renseigné quand status vaut "timeout". */
  timeoutMs?: number;
  /** Message du système quand status vaut "spawn_error". */
  error?: string;
}

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

export async function runCommand(command: string, cwd: string, signal?: AbortSignal, exec?: ExecOptions): Promise<string> {
  return renderCommandResult(await runCommandResult(command, cwd, signal, DEFAULT_TIMEOUT_MS, exec));
}

export function runCommandResult(command: string, cwd: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS, exec?: ExecOptions): Promise<CommandResult> {
  const base = { exitCode: null, signal: null, output: "" };
  if (signal?.aborted) return Promise.resolve({ ...base, started: false, status: "cancelled", durationMs: 0 });
  return new Promise((resolve) => {
    const shell = pickShell();
    let output = "";
    let finished = false;
    const started = Date.now();

    const proc = spawn(shell.exe, shell.argsFor(managedCommand(shell, command), exec?.login ?? true), {
      cwd,
      env: exec?.env ?? process.env,
      detached: process.platform !== "win32", // process group for killTree
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Node ne fournit pas de pid quand le lancement échoue.
    const spawned = proc.pid !== undefined;
    const finish = (fields: Pick<CommandResult, "status"> & Partial<CommandResult>) =>
      resolve({ ...base, started: spawned, durationMs: Date.now() - started, output, ...fields });

    const append = (chunk: Buffer) => {
      // Keep the end of a long build/test log: failures usually appear there.
      // Dropping all output after 32k hid the actual failure from the model.
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_CAP * 4) output = truncateMiddle(output, OUTPUT_CAP * 4);
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);

    // User interrupt (esc / ctrl+c / web stop button): kill the whole tree now.
    const onAbort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      killTree(proc.pid!);
      proc.stdout.destroy();
      proc.stderr.destroy();
      finish({ status: "cancelled" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      killTree(proc.pid!);
      proc.stdout.destroy();
      proc.stderr.destroy();
      finish({ status: "timeout", timeoutMs });
    }, timeoutMs);

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      finish({ status: "spawn_error", started: false, error: err.message });
    });

    proc.on("close", (code, sig) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      finish(code === null ? { status: "signaled", signal: sig } : { status: "exited", exitCode: code });
    });

    if (signal?.aborted) onAbort();
  });
}
