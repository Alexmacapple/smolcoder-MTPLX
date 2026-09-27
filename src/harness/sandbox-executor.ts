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
import { isNetworkDestination, isToolFolder, readPolicy } from "./store";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface FootprintEntry {
  /** Nom stable, cité par la documentation et les tests. */
  id: string;
  /** Ses règles, chacune une ligne entière du profil. */
  rules: readonly string[];
}

/** L'allow-list de l'empreinte des outils de développement (#17) : tout ce
 * que le profil accorde au-delà du workspace et du TMPDIR borné, une règle
 * par ligne, pour que retirer une entrée retire exactement ses règles.
 * Chaque entrée a un cas positif qui échoue sans elle sur macOS réel
 * (test/os/seatbelt.os.test.js) ; justification et mesures dans
 * docs/allowlist-outils.md. Le noyau compare des chemins réels : /etc, /var
 * et /tmp sont des liens vers /private. Jamais le dossier personnel, ni
 * trousseau, LaunchServices (`open`), presse-papiers, Apple Events ou
 * launchd : autant de sorties du bac. */
export const TOOL_FOOTPRINT: readonly FootprintEntry[] = [
  { id: "process-fork", rules: ["(allow process-fork)"] },
  { id: "process-exec", rules: ["(allow process-exec)"] },
  { id: "signal", rules: ["(allow signal (target same-sandbox))"] },
  { id: "sysctl-read", rules: ["(allow sysctl-read)"] },
  { id: "user-directory", rules: ['(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))'] },
  { id: "file-metadata", rules: ["(allow file-read-metadata)"] },
  { id: "root-folder", rules: ['(allow file-read* (literal "/"))'] },
  { id: "usr", rules: ['(allow file-read* (subpath "/usr"))'] },
  { id: "system", rules: ['(allow file-read* (subpath "/System"))'] },
  { id: "developer-tools", rules: ['(allow file-read* (subpath "/Library/Developer"))'] },
  { id: "homebrew", rules: ['(allow file-read* (subpath "/opt"))'] },
  { id: "homebrew-openssl", rules: ['(allow file-read* (subpath "/opt/homebrew/etc/openssl@3"))'] },
  { id: "etc", rules: ['(allow file-read* (subpath "/private/etc"))'] },
  { id: "timezone", rules: ['(allow file-read* (subpath "/private/var/db/timezone"))'] },
  { id: "dev-null", rules: ['(allow file-read* file-write* (literal "/dev/null"))'] },
  { id: "dev-sources", rules: ['(allow file-read* (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))'] },
  { id: "dev-fd", rules: ['(allow file-read* file-write* (regex #"^/dev/fd/"))'] },
];
/** Sous les racines accordées, les données et la configuration des services
 * de Homebrew (bases, my.cnf, odbc.ini…) : refusées, sauf la configuration
 * OpenSSL que l'entrée homebrew-openssl rouvre après ce refus.
 * `/usr/local/etc` (Homebrew sur Intel) reste tel quel : non mesuré ici. */
const SERVICE_DATA = ["/opt/homebrew/var", "/opt/homebrew/etc", "/usr/local/var"];
/** Les entrées placées après le refus des données de services. */
const AFTER_SERVICE_DATA = new Set(["homebrew-openssl"]);

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
  /** Dossiers d'outils nommés par la politique (chemins réels) : lecture
   * seule. Absent : aucun. */
  tools?: string[];
  /** `git: "read"` de la politique : le contenu de `.git` lisible, jamais
   * modifiable. */
  git?: boolean;
  /** Ports `localhost:<port>` d'écoute nommés par la politique. */
  listen?: string[];
}

/** Le profil Seatbelt d'une commande, depuis la politique. L'ordre compte :
 * la dernière règle qui correspond l'emporte. */
export function seatbeltProfile(g: SeatbeltGrants): string {
  const tools = g.tools ?? [];
  const listen = g.listen ?? [];
  for (const d of [...g.network, ...listen]) {
    if (!isNetworkDestination(d)) throw new SandboxProfileError(`network destination ${JSON.stringify(d)} is not localhost:<port>`);
  }
  for (const t of tools) {
    if (!isToolFolder(t)) throw new SandboxProfileError(`tool folder ${JSON.stringify(t)} is not an absolute folder in normal form`);
  }
  const sub = (p: string) => `(subpath ${sbString(p)})`;
  const re = (r: string) => `(regex ${sbString(r)})`;
  const rule = (head: string, filters: string[]) => (filters.length ? [`(${head} ${filters.join(" ")})`] : []);
  const prot = protectedPathRules(g.workspace, g.rules);
  // git en lecture : le refus de `.git` est levé pour la lecture seule, sauf
  // sous un autre nom protégé (un `.env` rangé dans `.git` reste fermé).
  const gitRe = protectedPathRules(g.workspace, { protect: [".git"], except: [] }).deny[0];
  const gitRead = g.git && prot.deny.includes(gitRe)
    ? ["; git en lecture (git: \"read\") : .git lisible, jamais modifiable", `(allow file-read-data (require-all ${re(gitRe)}${prot.deny.filter((r) => r !== gitRe).map((r) => ` (require-not ${re(r)})`).join("")}))`]
    : [];
  return [
    "(version 1)",
    "; smolcoder, profil mission (#16) : généré depuis la politique d'accès",
    "(deny default)",
    "; empreinte des outils (#17) : chaque entrée est justifiée dans docs/allowlist-outils.md",
    ...TOOL_FOOTPRINT.filter((e) => !AFTER_SERVICE_DATA.has(e.id)).flatMap((e) => e.rules),
    ...rule("deny file-read*", SERVICE_DATA.map(sub)),
    ...TOOL_FOOTPRINT.filter((e) => AFTER_SERVICE_DATA.has(e.id)).flatMap((e) => e.rules),
    "; workspace et TMPDIR borné : lecture et écriture",
    `(allow file-read* file-write* ${sub(g.workspace)} ${sub(g.tmpDir)})`,
    "; dossiers d'outils nommés par la politique (tools) : lecture seule",
    ...rule("allow file-read*", tools.map(sub)),
    "; noms protégés de la politique (contenu et écriture), puis leurs exceptions",
    ...prot.deny.map((r) => `(deny file-read-data file-write* ${re(r)})`),
    ...prot.except.map((e) => `(allow file-read-data file-write* (require-all ${re(e.leaf)} ${e.notUnder.map((n) => `(require-not ${re(n)})`).join(" ")}))`),
    ...gitRead,
    "; contrôles de l'hôte : ni lus ni modifiés, quoi qu'accordent les règles précédentes",
    ...rule("deny file-read* file-write*", g.hostPaths.map(sub)),
    "; réseau : fermé, sauf les destinations et les écoutes nommées par la politique",
    ...rule("allow network-outbound", g.network.map((d) => `(remote ip ${sbString(d)})`)),
    ...rule("allow network-inbound", listen.map((d) => `(local ip ${sbString(d)})`)),
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
  /** Les ports d'écoute que la politique accorde en ce moment ; vide quand
   * le backend refuse ou que la politique est illisible. */
  listening(): string[];
}

/** La politique au moment du lancement : ce qu'en tire le profil, ou le
 * motif qui empêche de la lire. */
export type SandboxPolicy = { rules: PathRules; network: string[]; tools?: string[]; git?: boolean; listen?: string[] } | string;

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
  return { status: { backend: "seatbelt", state: "unavailable", reason }, tmpDir: null, start: () => refused(refusal(reason)), listening: () => [] };
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
    listening() {
      const policy = opts.policy();
      return typeof policy === "string" ? [] : [...(policy.listen ?? [])];
    },
    start(req: ExecRequest): Execution {
      // Relue à chaque lancement, comme la décision : le profil suit la politique.
      const policy = opts.policy();
      if (typeof policy === "string") return refused(`the access policy cannot be read (${policy}): no sandbox profile can be built, so nothing was run`);
      // Le noyau compare des chemins réels ; un dossier d'outils qui contient
      // le dossier personnel l'ouvrirait en entier.
      const tools = [...new Set((policy.tools ?? []).map(real))];
      for (const t of tools) {
        const home = homes().find((h) => inside(h, t));
        if (home) return refused(`the tool folder ${t} named by the access policy holds the home folder ${home}, which the sandbox must keep unreadable, so nothing was run`);
      }
      let profile: string;
      try {
        profile = seatbeltProfile({ workspace, tmpDir: bounded, rules: policy.rules, network: policy.network, hostPaths, tools, git: policy.git, listen: policy.listen });
      } catch (err: any) {
        return refused(`the sandbox profile cannot be built (${err?.message ?? err}), so nothing was run`);
      }
      // Ajouts à l'environnement demandé : le TMPDIR que ce bac accorde, et,
      // quand la politique ouvre .git en lecture, une configuration globale
      // vide pour git, qui s'arrête sinon sur un ~/.gitconfig illisible.
      const env = { ...req.env, TMPDIR: `${bounded}/`, ...(policy.git ? { GIT_CONFIG_GLOBAL: "/dev/null" } : {}) };
      return run(req, () => {
        const shell = pickShell();
        return { exe: sandboxExec, args: ["-p", profile, shell.exe, ...shellArgs(shell, req)], env };
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
      if (r.state === "ok") return { rules: r.policy.paths, network: r.policy.network ?? [], tools: r.policy.tools ?? [], git: r.policy.git === "read", listen: r.policy.listen ?? [] };
      return r.state === "absent" ? "missing from the host store" : r.state === "unknown-schema" ? `unknown schema ${JSON.stringify(r.schema)}` : r.reason;
    },
    hostPaths: [path.dirname(path.dirname(mission.dir)), DATA_DIR, CONFIG_PATH],
    canary: mission.dir,
  });
}

/** La ligne d'état montrée à l'ouverture d'une session du profil, avec les
 * écoutes que la politique accorde à ce moment : Seatbelt ne sait pas les
 * borner au loopback (mesuré, docs/allowlist-outils.md), la ligne le dit. */
export function isolationLine(s: IsolationStatus, listening: string[] = []): string {
  if (s.state !== "ready") return `· isolation unavailable (${s.reason}) — under the mission profile no command runs`;
  const base = "· isolation: macOS Seatbelt — commands read the system and the workspace, write only there and in a private temporary folder, and reach no network beyond the loopback ports the policy names";
  return listening.length
    ? `${base}; they may listen on ${listening.join(", ")}, which the local network can reach when the server listens on every interface (Seatbelt cannot keep a listener on the loopback)`
    : base;
}

/** Le libellé court de l'état permanent (#18) : ligne d'état du terminal et
 * pastille de la page web. */
export function isolationLabel(s: IsolationStatus, listening: string[] = []): string {
  if (s.state !== "ready") return "isolation unavailable";
  return listening.length ? `isolated · listens ${listening.join(", ")}` : "isolated";
}

/** L'état de l'isolation que l'interface garde visible toute la session
 * (#18) : prêt ou indisponible, son motif, les écoutes que la politique
 * accorde à cet instant (relue à chaque appel), le libellé court et la ligne
 * d'ouverture complète. */
export interface IsolationState extends IsolationStatus {
  listen: string[];
  label: string;
  line: string;
}

export function isolationState(exec: IsolatedExecutor): IsolationState {
  const listen = exec.listening();
  return { ...exec.status, listen, label: isolationLabel(exec.status, listen), line: isolationLine(exec.status, listen) };
}
