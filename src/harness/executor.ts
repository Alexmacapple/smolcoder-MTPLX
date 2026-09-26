// Contrat d'exécution unique des commandes du projet (H03-1, #15). Les quatre
// surfaces qui lancent une commande — run_command, les tâches de fond, les
// vérifications automatiques et le terminal web — demandent leurs processus à
// un exécuteur ; aucune ne les lance elle-même. L'adaptateur hôte reprend à
// l'identique le lancement historique : shell choisi par pickShell, groupe de
// processus, destruction de l'arbre, délai et annulation. Un backend isolé
// (#16), ou un faux dans les tests, se substitue à lui à cette couture. La
// décision d'accès reste prise avant, par la politique (#11) : l'exécuteur ne
// juge rien, il exécute ce qu'on lui demande dans l'environnement donné.
//
// Choix du shell (Windows) : les modèles locaux écrivent du POSIX, donc Git
// Bash quand il existe, jamais le bash WSL de System32 (autre système de
// fichiers), PowerShell en dernier recours. Le shell choisi est nommé dans le
// prompt système pour que le modèle sache quel dialecte écrire.

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

/** Dialecte du shell : le terminal web écrit ses sentinelles en conséquence. */
export function shellDialect(shell: ShellInfo): "posix" | "powershell" {
  return /powershell|pwsh/i.test(shell.exe) ? "powershell" : "posix";
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

/** Keep bash alive while ordinary background jobs own its output pipes. On
 * Windows taskkill cannot find descendants after their shell has exited. */
export function managedCommand(shell: ShellInfo, command: string): string {
  return /(?:^|[\\/])bash(?:\.exe)?$/.test(shell.exe)
    ? `${command}\n__smol_command_status=$?\nwait\nexit "$__smol_command_status"`
    : command;
}

/** Issue d'une commande, telle que l'observe le système. Les décisions
 * (acceptation, contrôles de progression) lisent ces champs, jamais le texte
 * affiché au modèle, qui n'en est qu'une projection. */
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

/** La surface qui demande l'exécution ; un backend peut en dépendre. */
export type ExecSurface = "command" | "task" | "check" | "terminal";

export interface ExecRequest {
  surface: ExecSurface;
  /** Ligne confiée au shell. null : le shell lui-même, persistant, qui lit
   * ses lignes sur son entrée standard (terminal web). */
  command: string | null;
  cwd: string;
  /** Transmis tel quel : l'exécuteur n'y ajoute ni n'y retire rien. */
  env: NodeJS.ProcessEnv;
  /** Shell de connexion, qui lit les fichiers de démarrage de l'utilisateur. */
  login: boolean;
  /** Au-delà, l'arbre est tué et le résultat vaut "timeout". Absent : aucun délai. */
  timeoutMs?: number;
  /** Annulation : l'arbre est tué, les flux fermés, le résultat vaut
   * "cancelled" sans attendre la fin. Déjà annulé : rien n'est lancé. */
  signal?: AbortSignal;
  /** "buffer" : stdout et stderr mêlés, plafonnés, dans result.output.
   * "stream" : chaque morceau décodé passe à onOutput ; result.output reste vide. */
  capture: "buffer" | "stream";
  onOutput?: (text: string) => void;
  /** Fermeture des flux du processus, avec le code brut du système (négatif
   * après un échec de lancement, null après un signal). Toujours appelée
   * après le règlement de result, jamais à sa place. */
  onClose?: (code: number | null) => void;
}

export interface Execution {
  /** Premier constat : annulation, délai, échec du lancement ou fin du processus. */
  readonly result: Promise<CommandResult>;
  /** Écrit sur l'entrée standard (shell persistant). Faux : elle n'est pas
   * ouverte en écriture, rien n'est écrit. Lève si le flux refuse l'écriture. */
  write(text: string): boolean;
  /** Tue l'arbre de processus sans fermer les flux : la sortie en vol arrive
   * encore, puis la fin (signaled). */
  kill(): void;
}

export interface Executor {
  /** Lève, comme spawn, si les arguments sont refusés d'emblée. */
  start(req: ExecRequest): Execution;
}

/** Plafond de la capture "buffer" : quatre fois le rendu de run_command. */
const CAPTURE_CAP = 32_000;

/** L'adaptateur hôte : le processus tourne avec les droits du compte, dans
 * l'environnement demandé. Comportement historique des quatre surfaces. */
export const hostExecutor: Executor = {
  start(req: ExecRequest): Execution {
    const base = { exitCode: null, signal: null, output: "" };
    let resolve!: (r: CommandResult) => void;
    const result = new Promise<CommandResult>((r) => (resolve = r));
    if (req.signal?.aborted) {
      resolve({ ...base, started: false, status: "cancelled", durationMs: 0 });
      return { result, write: () => false, kill: () => {} };
    }
    const shell = pickShell();
    const args = req.command === null
      ? shellDialect(shell) === "posix" ? (req.login ? ["-l"] : []) : ["-NoProfile", "-NonInteractive", "-Command", "-"]
      : shell.argsFor(managedCommand(shell, req.command), req.login);
    let output = "";
    let finished = false;
    const started = Date.now();

    const proc = spawn(shell.exe, args, {
      cwd: req.cwd,
      env: req.env,
      detached: process.platform !== "win32", // process group for killTree
      windowsHide: true,
      stdio: [req.command === null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    // Node ne fournit pas de pid quand le lancement échoue.
    const spawned = proc.pid !== undefined;
    const finish = (fields: Pick<CommandResult, "status"> & Partial<CommandResult>) =>
      resolve({ ...base, started: spawned, durationMs: Date.now() - started, output, ...fields });

    const append = req.capture === "buffer"
      ? (chunk: Buffer) => {
          // Keep the end of a long build/test log: failures usually appear there.
          // Dropping all output after 32k hid the actual failure from the model.
          output += chunk.toString("utf8");
          if (output.length > CAPTURE_CAP) output = truncateMiddle(output, CAPTURE_CAP);
        }
      : (chunk: Buffer) => req.onOutput?.(chunk.toString("utf8"));
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);

    // User interrupt (esc / ctrl+c / web stop button, task stop): kill the whole tree now.
    const onAbort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      killTree(proc.pid!);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      finish({ status: "cancelled" });
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => req.signal?.removeEventListener("abort", onAbort);

    const timer = req.timeoutMs === undefined ? undefined : setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      killTree(proc.pid!);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      finish({ status: "timeout", timeoutMs: req.timeoutMs });
    }, req.timeoutMs);

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      finish({ status: "spawn_error", started: false, error: err.message });
    });

    proc.on("close", (code, sig) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        cleanup();
        finish(code === null ? { status: "signaled", signal: sig } : { status: "exited", exitCode: code });
      }
      // Après le résultat : un échec de lancement est constaté avant la fermeture.
      const onClose = req.onClose;
      if (onClose) void result.then(() => onClose(code));
    });

    if (req.signal?.aborted) onAbort();

    return {
      result,
      write(text: string): boolean {
        if (!proc.stdin?.writable) return false;
        proc.stdin.write(text);
        return true;
      },
      kill(): void {
        if (proc.pid) killTree(proc.pid);
      },
    };
  },
};
