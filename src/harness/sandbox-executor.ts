// Backend d'exécution isolé pour macOS (H03-2, #16) : Seatbelt, le bac à
// sable du noyau, appliqué par `sandbox-exec -p <profil>` autour du shell
// habituel, derrière le contrat d'exécuteur (#15). Le profil est généré
// depuis la politique d'accès (#11) à chaque lancement : refus par défaut,
// lecture du système et du workspace, écriture dans le workspace et un TMPDIR
// privé, noms protégés et contrôles de l'hôte refusés en dernier, réseau
// fermé sauf les destinations nommées. Le backend est sondé à sa création ;
// absent ou inopérant, il refuse chaque requête : sous le profil mission,
// jamais de repli sur le shell non isolé. `sandbox-exec` est déprécié par
// Apple mais fonctionnel, ce que la sonde vérifie sur la machine même.
// Modèle de menace, choix et limites : docs/decision-backend-isole.md.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CONFIG_PATH, DATA_DIR } from "../config";
import type { PathRules } from "../sandbox";
import { CommandResult, ExecRequest, Execution, Executor, launch, LaunchSpec, pickShell, probeSync, ProbeResult, shellArgs } from "./executor";
import type { Mission } from "./mission";
import { isNetworkDestination, readPolicy } from "./store";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Lecture du contenu : le système et les outils installés, jamais le
 * dossier personnel. /etc, /var et /tmp sont des liens vers /private, et le
 * noyau compare des chemins réels. */
export const SYSTEM_READ_ROOTS = ["/usr", "/bin", "/sbin", "/System", "/Library", "/opt", "/private/etc", "/private/var/select", "/private/var/db/timezone", "/dev"];
/** Sous ces racines, les données des services locaux (bases de Homebrew). */
const SERVICE_DATA = ["/opt/homebrew/var", "/usr/local/var"];
/** Services Mach : annuaire des comptes (getpwuid), notifications, journal.
 * Ni trousseau, ni LaunchServices (`open`), ni presse-papiers, ni Apple
 * Events, ni launchd : autant de sorties du bac. */
const MACH_SERVICES = ["com.apple.system.opendirectoryd.libinfo", "com.apple.system.notification_center", "com.apple.system.logger", "com.apple.logd"];
const DEV_WRITE = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"];

export class SandboxProfileError extends Error {}

/** Une chaîne du langage de profil : guillemet et antislash échappés, aucun
 * caractère de contrôle. */
function sbString(s: string): string {
  if (/[\x00-\x1f\x7f]/.test(s)) throw new SandboxProfileError(`a sandbox profile cannot hold a control character: ${JSON.stringify(s)}`);
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Un nom de la politique (joker `*`) en expression d'un seul segment de
 * chemin, sans tenir compte de la casse : le moteur de Seatbelt n'a pas
 * d'option pour cela, chaque lettre devient une classe. */
function segmentRe(pattern: string): string {
  return pattern
    .split("*")
    .map((part) => [...part].map((ch) => {
      const lo = ch.toLowerCase(), up = ch.toUpperCase();
      return lo !== up && lo.length === 1 && up.length === 1 ? `[${lo}${up}]` : reEscape(ch);
    }).join(""))
    .join("[^/]*");
}

export interface ProtectedRules {
  /** Tout chemin du workspace dont un segment porte un nom protégé. */
  deny: string[];
  /** Une feuille exceptée, rouverte si aucun dossier protégé ne la contient. */
  except: { leaf: string; notUnder: string[] }[];
}

/** Les noms protégés de la politique en expressions de chemin. Seatbelt ne
 * connaît pas l'anticipation négative : une exception ne rouvre qu'un nom
 * final, jamais le contenu d'un dossier excepté ; plus strict que la
 * politique, jamais plus large. */
export function protectedPathRules(workspace: string, rules: PathRules): ProtectedRules {
  if (!rules.protect.length) return { deny: [], except: [] };
  const root = `^${reEscape(workspace)}(/[^/]+)*/`;
  const segs = rules.protect.map(segmentRe);
  return {
    deny: segs.map((s) => `${root}${s}(/.*)?$`),
    except: rules.except.map((e) => ({ leaf: `${root}${segmentRe(e)}$`, notUnder: segs.map((s) => `${root}${s}/`) })),
  };
}

export interface SeatbeltGrants {
  /** Chemins réels : le noyau ne voit jamais un lien symbolique. */
  workspace: string;
  tmpDir: string;
  rules: PathRules;
  /** Destinations `localhost:<port>` nommées par la politique. */
  network: string[];
  /** Contrôles de l'hôte : ni lus ni modifiés, même dans le workspace. */
  hostPaths: string[];
}

/** Le profil Seatbelt d'une commande, depuis la politique. L'ordre compte :
 * la dernière règle qui correspond l'emporte. */
export function seatbeltProfile(g: SeatbeltGrants): string {
  for (const d of g.network) {
    if (!isNetworkDestination(d)) throw new SandboxProfileError(`network destination ${JSON.stringify(d)} is not localhost:<port>`);
  }
  const sub = (p: string) => `(subpath ${sbString(p)})`;
  const re = (r: string) => `(regex ${sbString(r)})`;
  const rule = (head: string, filters: string[]) => (filters.length ? [`(${head} ${filters.join(" ")})`] : []);
  const prot = protectedPathRules(g.workspace, g.rules);
  return [
    "(version 1)",
    "; smolcoder, profil mission (#16) : généré depuis la politique d'accès",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    ...rule("allow mach-lookup", MACH_SERVICES.map((n) => `(global-name ${sbString(n)})`)),
    "; lecture : métadonnées partout (stat, realpath), contenu du système seulement",
    "(allow file-read-metadata)",
    ...rule("allow file-read*", ['(literal "/")', ...SYSTEM_READ_ROOTS.map(sub)]),
    ...rule("deny file-read*", SERVICE_DATA.map(sub)),
    "; workspace et TMPDIR borné : lecture et écriture",
    `(allow file-read* file-write* ${sub(g.workspace)} ${sub(g.tmpDir)})`,
    ...rule("allow file-write*", [...DEV_WRITE.map((p) => `(literal ${sbString(p)})`), '(regex #"^/dev/fd/")']),
    '(allow file-ioctl (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    "; noms protégés de la politique (contenu et écriture), puis leurs exceptions",
    ...prot.deny.map((r) => `(deny file-read-data file-write* ${re(r)})`),
    ...prot.except.map((e) => `(allow file-read-data file-write* (require-all ${re(e.leaf)} ${e.notUnder.map((n) => `(require-not ${re(n)})`).join(" ")}))`),
    "; contrôles de l'hôte : ni lus ni modifiés, quoi qu'accordent les règles précédentes",
    ...rule("deny file-read* file-write*", g.hostPaths.map(sub)),
    "; réseau : fermé, sauf les destinations nommées par la politique",
    ...rule("allow network-outbound", g.network.map((d) => `(remote ip ${sbString(d)})`)),
    "",
  ].join("\n");
}

export interface IsolationStatus {
  backend: "seatbelt";
  state: "ready" | "unavailable";
  /** Pourquoi le backend sert ou refuse, en une phrase. */
  reason: string;
}

export interface IsolatedExecutor extends Executor {
  readonly status: IsolationStatus;
  /** Le TMPDIR privé des commandes ; null quand le backend refuse. */
  readonly tmpDir: string | null;
}

/** La politique au moment du lancement : ce qu'en tire le profil, ou le
 * motif qui empêche de la lire. */
export type SandboxPolicy = { rules: PathRules; network: string[] } | string;

export interface SandboxDeps {
  platform?: NodeJS.Platform;
  sandboxExec?: string;
  /** Le lanceur commun de ./executor ; un faux dans les tests. */
  launch?: (req: ExecRequest, spec: () => LaunchSpec) => Execution;
  probe?: (exe: string, args: string[], env: NodeJS.ProcessEnv) => ProbeResult;
  /** Où créer le TMPDIR privé ; par défaut le dossier temporaire du système. */
  tmpRoot?: string;
}

export interface SandboxOptions extends SandboxDeps {
  workspace: string;
  policy: () => SandboxPolicy;
  hostPaths: string[];
  /** Un dossier hôte existant que le bac doit refuser de lister : la sonde
   * le vérifie avant toute commande. */
  canary: string;
}

const PROBE_OK = "SEATBELT_OK";
const PROBE_SCRIPT = `if /bin/ls "$1" >/dev/null 2>&1; then echo LEAK; exit 3; fi; echo ${PROBE_OK}`;

/** Une requête refusée sans processus : aucun flux, donc aucune fermeture. */
function refused(error: string): Execution {
  const result: CommandResult = { started: false, status: "spawn_error", exitCode: null, signal: null, durationMs: 0, output: "", error };
  return { result: Promise.resolve(result), write: () => false, kill: () => {} };
}

function refusal(reason: string): string {
  return `isolated execution unavailable (${reason}): nothing was run — under the mission profile a command never falls back to the unconfined shell. To run commands without isolation, restart smol without --mission.`;
}

/** Un exécuteur qui refuse tout : backend absent, ou surface sans backend. */
export function unavailableExecutor(reason: string): IsolatedExecutor {
  return { status: { backend: "seatbelt", state: "unavailable", reason }, tmpDir: null, start: () => refused(refusal(reason)) };
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    /* absent : son dossier parent, s'il existe */
  }
  try {
    return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
  } catch {
    return path.resolve(p);
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function homes(): string[] {
  const out = [os.homedir()];
  try {
    out.push(os.userInfo().homedir);
  } catch {
    /* compte sans entrée d'annuaire */
  }
  return [...new Set(out.filter(Boolean).map(real))];
}

/** Le backend Seatbelt, sondé à sa création. Refusé, il le reste : chaque
 * requête rend alors un échec de lancement explicite, sans rien lancer. */
export function createSandboxExecutor(opts: SandboxOptions): IsolatedExecutor {
  const platform = opts.platform ?? process.platform;
  const sandboxExec = opts.sandboxExec ?? SANDBOX_EXEC;
  const run = opts.launch ?? launch;
  const probe = opts.probe ?? probeSync;
  const workspace = real(opts.workspace);
  const hostPaths = [...new Set(opts.hostPaths.map(real))];
  let tmpDir: string | null = null;

  const unusable = (): string | null => {
    if (platform !== "darwin") return `isolated execution is implemented only on macOS (Seatbelt); this system is ${platform}`;
    try {
      fs.accessSync(sandboxExec, fs.constants.X_OK);
    } catch {
      return `${sandboxExec} not found or not executable`;
    }
    const home = homes().find((h) => inside(h, workspace));
    if (home) return `the workspace ${workspace} contains the home folder ${home}, which the sandbox could not protect`;
    const canary = real(opts.canary);
    if (!fs.existsSync(canary)) return `the probe needs an existing host folder, and ${canary} does not exist`;
    try {
      tmpDir = fs.mkdtempSync(path.join(real(opts.tmpRoot ?? os.tmpdir()), "smol-sandbox-"));
    } catch (err: any) {
      return `cannot create the private temporary folder (${err?.message ?? err})`;
    }
    if (inside(tmpDir, workspace)) return `the private temporary folder ${tmpDir} would lie inside the workspace`;
    let profile: string;
    try {
      profile = seatbeltProfile({ workspace, tmpDir, rules: { protect: [], except: [] }, network: [], hostPaths });
    } catch (err: any) {
      return `cannot build the sandbox profile (${err?.message ?? err})`;
    }
    const r = probe(sandboxExec, ["-p", profile, "/bin/sh", "-c", PROBE_SCRIPT, "smol-probe", canary], { PATH: "/usr/bin:/bin" });
    if (r.stdout.includes("LEAK")) return `the sandbox probe could read the host store (${canary}): Seatbelt does not confine commands on this system`;
    if (r.error || r.status !== 0 || r.stdout.trim() !== PROBE_OK) {
      const line = r.stderr.trim().split("\n")[0];
      return `the sandbox probe failed (${r.error ?? `exit ${r.status}`}${line ? `: ${line}` : ""})`;
    }
    return null;
  };

  const reason = unusable();
  if (reason) {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    return unavailableExecutor(reason);
  }
  const bounded = tmpDir!;
  return {
    status: { backend: "seatbelt", state: "ready", reason: `${sandboxExec} probed: the host store stays out of reach` },
    tmpDir: bounded,
    start(req: ExecRequest): Execution {
      // Relue à chaque lancement, comme la décision : le profil suit la politique.
      const policy = opts.policy();
      if (typeof policy === "string") return refused(`the access policy cannot be read (${policy}): no sandbox profile can be built, so nothing was run`);
      let profile: string;
      try {
        profile = seatbeltProfile({ workspace, tmpDir: bounded, rules: policy.rules, network: policy.network, hostPaths });
      } catch (err: any) {
        return refused(`the sandbox profile cannot be built (${err?.message ?? err}), so nothing was run`);
      }
      return run(req, () => {
        const shell = pickShell();
        // Seul ajout à l'environnement demandé : le TMPDIR que ce bac accorde.
        return { exe: sandboxExec, args: ["-p", profile, shell.exe, ...shellArgs(shell, req)], env: { ...req.env, TMPDIR: `${bounded}/` } };
      });
    },
  };
}

/** Le backend d'une mission : son workspace, sa politique relue au
 * lancement, et les contrôles de l'hôte (dossier de données de smol, qui
 * tient contrats, politiques et preuves, et fichier de configuration). */
export function missionExecutor(mission: Mission, deps: SandboxDeps = {}): IsolatedExecutor {
  return createSandboxExecutor({
    ...deps,
    workspace: mission.workspace,
    policy: () => {
      const r = readPolicy(mission.dir);
      if (r.state === "ok") return { rules: r.policy.paths, network: r.policy.network ?? [] };
      return r.state === "absent" ? "missing from the host store" : r.state === "unknown-schema" ? `unknown schema ${JSON.stringify(r.schema)}` : r.reason;
    },
    hostPaths: [path.dirname(path.dirname(mission.dir)), DATA_DIR, CONFIG_PATH],
    canary: mission.dir,
  });
}

/** La ligne d'état montrée à l'ouverture d'une session du profil. */
export function isolationLine(s: IsolationStatus): string {
  return s.state === "ready"
    ? "· isolation: macOS Seatbelt — commands read the system and the workspace, write only there and in a private temporary folder, and reach no network beyond the loopback ports the policy names"
    : `· isolation unavailable (${s.reason}) — under the mission profile no command runs`;
}
