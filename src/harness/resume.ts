// Reprise durable sous le profil mission (ticket #10, H05). Le journal
// d'effets vit dans proofs.jsonl (grammaire : ./store, décision :
// docs/decision-reprise-durable.md) : chaque action du modèle qui a un effet
// sur le projet y est enregistrée avant l'effet, puis son résultat observé
// après. À l'ouverture d'une session, une intention sans résultat devient
// `uncertain` — l'hôte l'enregistre avec ce que les fichiers en disent, sans
// jamais conclure — et les écritures et commandes restent suspendues tant que
// l'hôte (humain, ou appelant headless) ne l'a pas résolue. Aucune promesse
// « exactement une fois », aucune reprise automatique après un état
// incertain ; la réconciliation se limite aux fichiers (les tâches de fond
// vivent en mémoire et meurent avec le processus).

import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PathRules, protectedSegment, resolveInWorkspace } from "../sandbox";
import { readGitHead, shortRev } from "../session-state";
import { latestVerdicts, WorkspaceScan } from "./proofs";
import {
  appendProof,
  ApprovalAuthority,
  APPROVAL_AUTHORITIES,
  createLock,
  EffectEvidence,
  EffectIntentInput,
  EffectTool,
  EFFECT_ID_RE,
  HarnessStoreError,
  isRelativeWorkspacePath,
  LOCK_FILE,
  LOCK_SCHEMA,
  MAX_RESUME_FILES,
  observedLine,
  ProofEvent,
  readLock,
  readProofs,
  readResume,
  removeLock,
  replaceLock,
  ResumeRecord,
  RESUME_SCHEMA,
  WriterLock,
  writeResume,
} from "./store";

/** Code de sortie headless d'un run suspendu par la reprise : un effet
 * incertain attend l'hôte, ou le journal ne permet pas de conclure. */
export const RESUME_SUSPENDED_EXIT_CODE = 6;

/** Les trois points d'injection d'une coupure (tests, `SMOLCODER_TEST_CRASH_AT`) :
 * après l'intention et avant l'effet, après l'effet et avant son résultat,
 * après le résultat. */
export const CRASH_POINTS = ["before-effect", "after-effect", "after-receipt"] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Ce que la reprise lit d'une mission (évite l'import circulaire). */
export interface ResumeMission {
  readonly workspace: string;
  readonly dir: string;
  readonly fingerprint: string;
  scan(): WorkspaceScan;
  pathRules(): PathRules;
  status(): { steps: number };
  planView(): { fingerprint: string | null };
}

/** Le verrou d'écriture vu par cette session. */
export type LockState =
  | { state: "held"; tookOver?: LockHolder }
  | { state: "busy"; holder?: LockHolder }
  | { state: "unreadable"; reason: string }
  | { state: "released" }
  /** Un agent sans hôte de session : il ne prend pas le verrou. */
  | { state: "unmanaged" };

export interface LockHolder {
  pid: number;
  surface: string;
  since: string;
  session: string;
}

/** Ce qui a changé depuis l'état laissé par la dernière session. */
export interface ExternalChanges {
  head: { before: string | null; after: string | null } | null;
  /** Changements qui ne sont pas de l'agent : préservés, jamais attribués. */
  files: { path: string; change: "added" | "modified" | "removed" }[];
  /** Changés depuis alors qu'une commande de l'agent a tourné : attribuables à
   * personne avec certitude. */
  unattributed: string[];
  more: number;
  /** L'empreinte globale a changé, sans détail par fichier (au-delà des bornes). */
  digestChanged: boolean;
}

type IntentEvent = Extract<ProofEvent, { type: "effect"; kind: "intent" }>;
type ResultEvent = Extract<ProofEvent, { type: "effect"; kind: "result" }>;
type UncertainEvent = Extract<ProofEvent, { type: "effect"; kind: "uncertain" }>;
type ResolvedEvent = Extract<ProofEvent, { type: "effect"; kind: "resolved" }>;

/** Un effet tel que le journal le raconte. */
export interface EffectRecord {
  intent: IntentEvent;
  result: ResultEvent | null;
  uncertain: UncertainEvent | null;
  resolved: ResolvedEvent | null;
}

/** Un effet incertain, avec ce que les fichiers en disent maintenant. */
export interface UncertainEffect {
  id: string;
  tool: EffectTool;
  target: string;
  at: string;
  evidence: EffectEvidence;
  /** Lecture humaine de l'indice : jamais une conclusion. */
  meaning: string;
  resolved: boolean;
}

/** Ce que l'ouverture a constaté, pour l'humain, le headless et les tests. */
export interface ResumeReport {
  journal: "ok" | "absent" | "truncated-tail" | "unreadable" | "unknown-schema";
  journalReason?: string;
  /** Intentions devenues incertaines à cette ouverture. */
  newlyUncertain: string[];
  /** Effets incertains non résolus. */
  uncertain: UncertainEffect[];
  /** Effets terminés avant la reprise (intention et résultat). */
  completed: number;
  /** Enregistrements orphelins (résultat sans intention…), ignorés. */
  orphans: number;
  /** Critères dont le dernier verdict `passed` ne vaut plus pour les
   * fichiers actuels (#9) : périmés, jamais validés. */
  staleProofs: string[];
  lock: LockState;
  external: ExternalChanges | null;
  /** Consignes changées depuis la dernière session sous ce contrat. */
  instructionsDrift: string[];
  previous: { at: string; surface: string } | null;
  resumeRecord: string;
  suspended: boolean;
  reason: string | null;
}

/** Les changements externes en une phrase. */
export function describeExternal(x: ExternalChanges): string {
  const parts: string[] = [];
  if (x.head) parts.push(`HEAD moved ${shortRev(x.head.before)} → ${shortRev(x.head.after)}`);
  if (x.files.length) parts.push(`files changed outside the agent: ${x.files.slice(0, 10).map((f) => `${f.path} (${f.change})`).join(", ")}${x.files.length > 10 || x.more ? ", …" : ""}`);
  if (x.unattributed.length) parts.push(`files changed while an agent command ran, attributable to no one with certainty: ${x.unattributed.slice(0, 10).join(", ")}${x.unattributed.length > 10 || x.more ? ", …" : ""}`);
  if (x.digestChanged) parts.push("files changed (too many to list one by one)");
  return parts.join("; ");
}

/** Une coupure simulée (tests en processus) : elle traverse la boucle comme
 * une erreur, le journal restant dans l'état exact de la coupure. */
export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

/** L'effet en cours, entre son intention et son résultat. */
export interface EffectHandle {
  id: string;
  tool: EffectTool;
  abs: string | null;
}

/** Plie les événements `effect` du journal, dans l'ordre. */
export function foldEffects(events: ProofEvent[]): { effects: Map<string, EffectRecord>; orphans: number } {
  const effects = new Map<string, EffectRecord>();
  let orphans = 0;
  for (const e of events) {
    if (e.type !== "effect") continue;
    if (e.kind === "intent") {
      if (effects.has(e.id)) orphans++;
      else effects.set(e.id, { intent: e as IntentEvent, result: null, uncertain: null, resolved: null });
      continue;
    }
    const rec = effects.get(e.id);
    if (!rec) {
      orphans++;
      continue;
    }
    if (e.kind === "result" && !rec.result) rec.result = e as ResultEvent;
    else if (e.kind === "uncertain" && !rec.uncertain && !rec.result) rec.uncertain = e as UncertainEvent;
    else if (e.kind === "resolved" && rec.uncertain && !rec.resolved) rec.resolved = e as ResolvedEvent;
    else orphans++;
  }
  return { effects, orphans };
}

const describeTarget = (i: IntentEvent) => (i.path ?? i.command ?? "").slice(0, 120);

function meaningOf(evidence: EffectEvidence, tool: EffectTool): string {
  switch (evidence) {
    case "before":
      return "the file is as it was before the action: it appears not applied";
    case "expected":
      return "the file matches what the action would have written: it appears applied";
    case "neither":
      return tool === "edit_file"
        ? "the file changed since before the action: applied, partly written, or changed by something else"
        : "the file matches neither its content before the action nor the intended one: partly written, or changed by something else";
    default:
      return "a command's effects cannot be read from the files";
  }
}

/** Les sessions de ce processus qui tiennent le verrou d'un workspace : un
 * verrou au PID de ce processus dont la session n'y figure plus est mort
 * (session terminée sans le rendre). */
const HELD = new Set<string>();

/** Le processus d'un verrou existe-t-il encore ? Sur une autre machine (dossier
 * personnel partagé), on ne le suppose jamais mort. */
function lockAlive(lock: WriterLock): boolean {
  if (lock.host !== os.hostname()) return true;
  if (lock.pid === process.pid) return HELD.has(lock.session);
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** Les empreintes des consignes chargées par une session (#10, C6). */
export interface InstructionPrints {
  global: string | null;
  workspace: string | null;
}

/** Un chemin que l'empreinte du workspace ne parcourt pas (#9) : ni
 * `node_modules`, ni `.git`, ni un nom protégé par la politique. */
function unscanned(rel: string, rules: PathRules): boolean {
  return rel.split("/").some((seg) => seg === "node_modules" || seg === ".git") || protectedSegment(rel, rules) !== null;
}

export class MissionResume {
  /** L'identifiant de cette session dans le journal et le verrou. */
  readonly session = randomBytes(6).toString("hex");
  /** Coupure injectée (tests en processus) ; en production, la variable
   * d'environnement SMOLCODER_TEST_CRASH_AT tue le processus au point nommé. */
  crash: ((point: CrashPoint) => void) | null = null;
  /** Un changement externe constaté en cours de session (HEAD déplacé) :
   * l'hôte de la session demande alors le réancrage du plan. */
  onExternal: ((summary: string) => void) | null = null;
  private effects = new Map<string, EffectRecord>();
  private report: ResumeReport | null = null;
  /** Un résultat n'a pas pu être écrit : plus aucun effet sans trace. */
  private broken: string | null = null;
  private writer = false;
  private released = false;
  /** La révision Git connue de la session : celle de l'ouverture, puis celle
   * d'un déplacement déjà signalé. */
  private head: string | null = null;
  /** L'état connu des fichiers (chemin relatif → empreinte des octets) : ce
   * que l'agent est censé savoir du workspace. null : inconnu (au-delà des
   * bornes, ou empreinte impossible). */
  private known: Map<string, string> | null = null;
  private instructions: InstructionPrints | null = null;
  private previous: ResumeRecord | null = null;
  /** La checklist du dernier point d'état, pour celui de la fin de session. */
  private lastPlanSteps: { text: string; done: boolean; note?: string }[] | null = null;

  /** `managed` : la session est portée par un hôte (terminal, web, headless),
   * qui prend le verrou d'écriture et le rend à la fin. Un agent seul (usage
   * en bibliothèque, tests) journalise ses effets et respecte le verrou d'un
   * autre, sans le prendre ni réconcilier. */
  constructor(readonly mission: ResumeMission, readonly surface: string, readonly managed = true) {}

  /** Les consignes que la session utilise, pour l'enregistrement de reprise. */
  setInstructions(prints: InstructionPrints): void {
    this.instructions = prints;
  }

  /** Ouvre la reprise : prend le verrou d'écriture s'il est libre (ou mort),
   * puis, seulement en écrivain, rend incertaine toute intention sans
   * résultat, constate ce qui a changé depuis la dernière session, et
   * enregistre l'état connu. Sans le verrou, la session lit et planifie. */
  open(prints?: InstructionPrints): ResumeReport {
    if (prints) this.instructions = prints;
    const lock = this.acquire();
    const read = readProofs(this.mission.dir);
    const journal = read.state;
    const events = read.state === "ok" || read.state === "truncated-tail" ? read.events : [];
    const { effects, orphans } = foldEffects(events);
    this.effects = effects;
    const newly: string[] = [];
    // Une intention sans résultat peut appartenir à l'écrivain vivant : seul
    // l'écrivain la déclare incertaine.
    if (this.writer) {
      for (const rec of effects.values()) {
        if (rec.result || rec.uncertain) continue;
        const { evidence, current } = this.evidence(rec.intent);
        const uncertain = { type: "effect" as const, fingerprint: this.mission.fingerprint, kind: "uncertain" as const, id: rec.intent.id, evidence, ...(current !== undefined ? { current } : {}) };
        if (journal === "ok") {
          try {
            rec.uncertain = appendProof(this.mission.dir, uncertain) as UncertainEvent;
          } catch (err: any) {
            this.broken = `the host journal refused a record (${err?.message ?? err})`;
            rec.uncertain = { ...uncertain, schema: "smolcoder/proof/v1", at: new Date().toISOString() } as UncertainEvent;
          }
        } else {
          // Journal abîmé : l'incertitude est constatée en mémoire, rien n'est écrit.
          rec.uncertain = { ...uncertain, schema: "smolcoder/proof/v1", at: new Date().toISOString() } as UncertainEvent;
        }
        newly.push(rec.intent.id);
      }
    }
    const completed = [...effects.values()].filter((r) => r.result).length;
    const scan = this.mission.scan();
    // #9 : une preuve datée par d'autres fichiers que ceux d'aujourd'hui est
    // périmée ; la reprise le dit au lieu de laisser croire au vert.
    const staleProofs = [...latestVerdicts(events, this.mission.fingerprint)]
      .filter(([, v]) => v.status === "passed" && (!scan.ok || v.files !== scan.digest))
      .map(([id]) => id);
    const prev = readResume(this.mission.dir);
    this.previous = prev.state === "ok" ? prev.record : null;
    this.head = readGitHead(this.mission.workspace);
    const external = this.compare(scan);
    const instructionsDrift = this.instructionDrift();
    this.report = {
      journal, ...("reason" in read ? { journalReason: read.reason } : {}),
      lock, newlyUncertain: newly, uncertain: [], completed, orphans, staleProofs, external, instructionsDrift,
      previous: this.previous ? { at: this.previous.at, surface: this.previous.surface } : null,
      resumeRecord: prev.state,
      suspended: false, reason: null,
    };
    this.refresh();
    if (this.writer) this.checkpoint({ scan });
    // Reprise refaite en cours de session (verrou repris) : l'hôte de la
    // session demande le réancrage du plan si le workspace a changé.
    if (external && this.onExternal) this.onExternal(`The workspace changed since the last known state: ${describeExternal(external)}.`);
    return this.report;
  }

  /** L'état courant de la reprise (sans relire le journal). */
  state(): ResumeReport {
    if (!this.report) return this.open();
    this.refresh();
    return this.report;
  }

  /** Cette session tient-elle le verrou d'écriture ? */
  get isWriter(): boolean {
    return this.writer;
  }

  // ---- verrou -----------------------------------------------------------------

  private acquire(): LockState {
    if (this.released) return { state: "released" };
    if (!this.managed) {
      const cur = readLock(this.mission.dir);
      if (cur.state === "ok" && lockAlive(cur.lock)) return { state: "busy", holder: { pid: cur.lock.pid, surface: cur.lock.surface, since: cur.lock.since, session: cur.lock.session } };
      return cur.state === "unreadable" ? { state: "unreadable", reason: cur.reason } : { state: "unmanaged" };
    }
    const me: WriterLock = { schema: LOCK_SCHEMA, pid: process.pid, host: os.hostname(), session: this.session, surface: this.surfaceName(), since: new Date().toISOString() };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (createLock(this.mission.dir, me)) {
        HELD.add(this.session);
        this.writer = true;
        return { state: "held" };
      }
      const cur = readLock(this.mission.dir);
      if (cur.state === "absent") continue; // rendu entre-temps : on réessaie
      if (cur.state === "unreadable") {
        this.writer = false;
        return { state: "unreadable", reason: cur.reason };
      }
      if (cur.lock.session === this.session) {
        HELD.add(this.session);
        this.writer = true;
        return { state: "held" };
      }
      if (lockAlive(cur.lock)) {
        this.writer = false;
        return { state: "busy", holder: { pid: cur.lock.pid, surface: cur.lock.surface, since: cur.lock.since, session: cur.lock.session } };
      }
      // Verrou mort (processus disparu) : repris, puis relu pour confirmer.
      replaceLock(this.mission.dir, me);
      const again = readLock(this.mission.dir);
      if (again.state === "ok" && again.lock.session === this.session) {
        HELD.add(this.session);
        this.writer = true;
        return { state: "held", tookOver: { pid: cur.lock.pid, surface: cur.lock.surface, since: cur.lock.since, session: cur.lock.session } };
      }
    }
    this.writer = false;
    return { state: "busy" };
  }

  /** Avant chaque effet : le verrou est-il toujours le nôtre ? Libre ou mort,
   * il est pris (et la reprise refaite : ce que l'écrivain précédent a laissé
   * incertain l'est aussi pour nous) ; tenu par une session vivante, non. */
  private ensureWriter(): string | null {
    if (this.released) return "this session has ended";
    if (!this.managed) {
      const lock = this.acquire();
      if (this.report) this.report.lock = lock;
      if (lock.state === "busy") return `another smolcoder session holds the writer lock for this workspace${lock.holder ? ` (${lock.holder.surface}, process ${lock.holder.pid}, since ${lock.holder.since})` : ""}: only one session writes at a time`;
      if (lock.state === "unreadable") return `the writer lock of this workspace is unreadable (${lock.reason}): repair or remove ${path.join(this.mission.dir, LOCK_FILE)} by hand`;
      return null;
    }
    if (this.writer) {
      const cur = readLock(this.mission.dir);
      if (cur.state === "ok" && cur.lock.session === this.session) return null;
      this.writer = false;
      HELD.delete(this.session);
    }
    const before = this.writer;
    this.open();
    if (this.writer && !before) return null;
    const lock = this.report!.lock;
    if (lock.state === "busy") {
      const h = lock.holder;
      return `another smolcoder session holds the writer lock for this workspace${h ? ` (${h.surface}, process ${h.pid}, since ${h.since})` : ""}: only one session writes at a time. This session can read and plan; it takes the lock when that session ends (checked again before each write)`;
    }
    if (lock.state === "unreadable") return `the writer lock of this workspace is unreadable (${lock.reason}): repair or remove ${path.join(this.mission.dir, LOCK_FILE)} by hand`;
    return null;
  }

  /** Rend le verrou (fin de session) après avoir enregistré l'état laissé,
   * plan compris quand l'hôte le donne. */
  release(plan?: { steps: { text: string; done: boolean; note?: string }[] } | null): void {
    if (this.released) return;
    if (this.writer) {
      try {
        this.checkpoint({ plan: plan ?? null });
      } catch {
        /* au mieux */
      }
      removeLock(this.mission.dir, this.session);
    }
    HELD.delete(this.session);
    this.writer = false;
    this.released = true;
  }

  private surfaceName(): string {
    return /^[a-z-]{1,20}$/.test(this.surface) ? this.surface : "agent";
  }

  // ---- changements externes -------------------------------------------------

  /** Ce qui a changé depuis l'état que la dernière session a laissé :
   * HEAD, fichiers ajoutés, modifiés, supprimés. Les effets enregistrés depuis
   * sont ceux de l'agent ; un fichier visé par un effet incertain n'est
   * attribué à personne ; après une commande de l'agent, rien n'est attribuable. */
  private compare(scan: WorkspaceScan): ExternalChanges | null {
    const prev = this.previous;
    const current = scan.ok ? new Map([...scan.files].map(([p, f]) => [p, f.sha256])) : null;
    if (!prev) {
      this.known = current;
      return null;
    }
    const expected = prev.files.entries ? new Map(Object.entries(prev.files.entries)) : null;
    const uncertainPaths = new Set<string>();
    let commandsSince = 0;
    for (const rec of this.effects.values()) {
      if (Date.parse(rec.intent.at) <= Date.parse(prev.at)) continue;
      const p = rec.intent.path;
      if (!p) {
        commandsSince++;
        continue;
      }
      if (rec.result && rec.result.after !== undefined) {
        if (rec.result.after === null) expected?.delete(p);
        else expected?.set(p, rec.result.after);
      } else uncertainPaths.add(p);
    }
    const headMoved = prev.head !== this.head ? { before: prev.head, after: this.head } : null;
    let files: { path: string; change: "added" | "modified" | "removed" }[] = [];
    let detail = true;
    if (expected && current) {
      for (const [p, h] of current) {
        if (uncertainPaths.has(p)) continue;
        if (!expected.has(p)) files.push({ path: p, change: "added" });
        else if (expected.get(p) !== h) files.push({ path: p, change: "modified" });
      }
      for (const p of expected.keys()) if (!current.has(p) && !uncertainPaths.has(p)) files.push({ path: p, change: "removed" });
      // L'état connu de l'agent : celui que la dernière session a laissé, ses
      // effets compris. Ce qui en diffère est à relire avant d'écrire.
      this.known = expected;
    } else {
      detail = false;
      this.known = current;
    }
    const digestChanged = !detail && !!prev.files.digest && (!scan.ok || prev.files.digest !== scan.digest);
    const unattributed = commandsSince > 0;
    if (!headMoved && !files.length && !digestChanged) return null;
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      head: headMoved,
      files: unattributed ? [] : files.slice(0, 50),
      unattributed: unattributed ? files.slice(0, 50).map((f) => f.path) : [],
      more: Math.max(0, files.length - 50),
      digestChanged,
    };
  }

  /** Les consignes d'aujourd'hui comparées à celles de la dernière session
   * sous ce contrat : un écart est signalé, jamais tu. */
  private instructionDrift(): string[] {
    const prev = this.previous;
    const now = this.instructions;
    if (!prev || !now || prev.contract !== this.mission.fingerprint) return [];
    const fp = (x: string | null) => (x ? x.slice(0, 12) : "absent");
    const out: string[] = [];
    if (prev.instructions.global !== now.global) out.push(`~/.smolcoder/AGENTS.md ${fp(prev.instructions.global)} → ${fp(now.global)}`);
    if (prev.instructions.workspace !== now.workspace) out.push(`AGENTS.md ${fp(prev.instructions.workspace)} → ${fp(now.workspace)}`);
    return out;
  }

  /** L'empreinte d'un fichier dans l'état connu : null s'il n'y était pas,
   * undefined si l'état n'en dit rien (hors empreinte, ou inconnu). Pour le
   * suivi de lecture de #19 (fichiers jamais vus par l'agent). */
  baselineHash(abs: string): string | null | undefined {
    if (!this.known) return undefined;
    let rel = path.relative(this.realWorkspace(), this.realOf(abs)).split(path.sep).join("/");
    if (!isRelativeWorkspacePath(rel)) rel = path.relative(this.mission.workspace, abs).split(path.sep).join("/");
    if (!isRelativeWorkspacePath(rel) || unscanned(rel, this.mission.pathRules())) return undefined;
    return this.known.get(rel) ?? null;
  }

  /** La progression du plan que la dernière session a laissée, reposée sur
   * la checklist quand le plan est le même (mêmes étapes, même empreinte). */
  applyPlanProgress(plan: { steps: { text: string; done: boolean; note?: string }[] }): number {
    const prev = this.previous?.plan;
    if (!prev || this.previous!.contract !== this.mission.fingerprint) return 0;
    const view = this.mission.planView();
    if ((view.fingerprint ?? null) !== prev.fingerprint) return 0;
    let n = 0;
    plan.steps.forEach((s, i) => {
      const saved = prev.steps[i];
      if (!saved || saved.text !== s.text) return;
      if (saved.done && !s.done) {
        s.done = true;
        n++;
      }
      if (saved.note && !s.note) s.note = saved.note;
    });
    return n;
  }

  /** Enregistre l'état que la session laisse (écrivain seulement) : révision
   * Git, empreintes des fichiers, consignes, plan, budget consommé. */
  checkpoint(input: { scan?: WorkspaceScan | null; plan?: { steps: { text: string; done: boolean; note?: string }[] } | null }): void {
    if (!this.writer || this.released) return;
    const scan = input.scan ?? this.mission.scan();
    const entries = scan.ok && scan.files.size <= MAX_RESUME_FILES ? Object.fromEntries([...scan.files].map(([p, f]) => [p, f.sha256])) : null;
    const view = this.mission.planView();
    if (input.plan) this.lastPlanSteps = input.plan.steps.map((s) => ({ ...s }));
    const steps = this.lastPlanSteps ?? this.previous?.plan?.steps ?? [];
    const record: ResumeRecord = {
      schema: RESUME_SCHEMA,
      at: new Date().toISOString(),
      session: this.session,
      surface: this.surfaceName(),
      contract: this.mission.fingerprint,
      head: readGitHead(this.mission.workspace),
      files: { digest: scan.ok ? scan.digest : null, entries },
      instructions: this.instructions ?? this.previous?.instructions ?? { global: null, workspace: null },
      plan: { fingerprint: view.fingerprint ?? null, steps: steps.slice(0, 50).map((s) => ({ text: s.text.slice(0, 500), done: !!s.done, ...(s.note ? { note: s.note.slice(0, 1000) } : {}) })) },
      steps: this.mission.status().steps,
    };
    try {
      writeResume(this.mission.dir, record);
    } catch {
      /* l'enregistrement de reprise est une aide ; le journal fait foi */
    }
  }

  // ---- journal d'effets --------------------------------------------------------

  private refresh(): void {
    const r = this.report!;
    r.uncertain = [...this.effects.values()]
      .filter((rec) => rec.uncertain)
      .map((rec) => ({
        id: rec.intent.id,
        tool: rec.intent.tool,
        target: describeTarget(rec.intent),
        at: rec.intent.at,
        evidence: rec.uncertain!.evidence,
        meaning: meaningOf(rec.uncertain!.evidence, rec.intent.tool),
        resolved: !!rec.resolved,
      }));
    const open = r.uncertain.filter((u) => !u.resolved);
    r.suspended = r.journal === "truncated-tail" || r.journal === "unreadable" || r.journal === "unknown-schema" || open.length > 0 || !!this.broken;
    r.reason =
      r.journal === "truncated-tail"
        ? `the last record of the host journal (${path.join(this.mission.dir, "proofs.jsonl")}) is truncated: it is not interpreted, and nothing can be recorded behind it. Repair it by hand (remove the incomplete last line) before anything else is written.`
        : r.journal === "unreadable" || r.journal === "unknown-schema"
          ? `the host journal is ${r.journal}${r.journalReason ? ` (${r.journalReason})` : ""}: no effect can be recorded, so none may happen`
          : this.broken
            ? `${this.broken}: no further effect may happen without its record`
            : open.length
              ? `${open.length} action${open.length > 1 ? "s" : ""} of an earlier session ${open.length > 1 ? "have" : "has"} no recorded result: ${open.map((u) => `${u.id} (${u.tool} ${u.target})`).join(", ")}. Their outcome is uncertain; only the host can resolve it (terminal or web: /resolve; headless: --resolve <id>)`
              : null;
  }

  /** Ce que les fichiers disent d'une intention sans résultat. */
  private evidence(i: IntentEvent): { evidence: EffectEvidence; current?: string | null } {
    if (i.tool !== "write_file" && i.tool !== "edit_file") return { evidence: "none" };
    const current = this.hashOf(i.path!);
    if (i.expected !== undefined && i.expected !== null && current === i.expected) return { evidence: "expected", current };
    if (current === i.before) return { evidence: "before", current };
    return { evidence: "neither", current };
  }

  /** Empreinte du contenu d'un fichier relatif du workspace ; null s'il est absent. */
  private hashOf(rel: string): string | null {
    try {
      return sha256(fs.readFileSync(path.join(this.mission.workspace, ...rel.split("/"))));
    } catch {
      return null;
    }
  }

  /** La porte de la reprise, consultée avant tout effet : le verrou, la
   * suspension, puis HEAD revérifié — un verrou ne bloque pas un éditeur
   * externe. null autorise, sinon le motif (la porte de la mission le rend
   * au modèle). */
  denial(): string | null {
    const lock = this.ensureWriter();
    if (lock) return `writes and commands are refused: ${lock}.`;
    const r = this.state();
    if (r.suspended) return `writes and commands are suspended by the host: ${r.reason}. Keep reading and inspecting; a message cannot lift this.`;
    const head = readGitHead(this.mission.workspace);
    if (head !== this.head) {
      const summary = `HEAD moved ${shortRev(this.head)} → ${shortRev(head)} during this session (a commit or checkout made outside it; it is preserved and is not the agent's)`;
      this.head = head;
      this.onExternal?.(`The workspace changed outside this session: ${summary}.`);
      return `this write or command was not applied: ${summary}. Re-read the files you rely on and re-anchor your plan, then retry.`;
    }
    return null;
  }

  /** Enregistre l'intention, sur le disque, avant l'effet. Lève si le
   * journal la refuse : l'effet n'a alors pas lieu. */
  begin(call: { id: string; name: string; args: Record<string, any> }): EffectHandle {
    const tool = call.name as EffectTool;
    const id = randomBytes(6).toString("hex");
    let abs: string | null = null;
    const input: EffectIntentInput = { type: "effect", fingerprint: this.mission.fingerprint, kind: "intent", id, session: this.session, call: String(call.id ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128), tool };
    if (tool === "write_file" || tool === "edit_file") {
      abs = resolveInWorkspace(this.mission.workspace, String(call.args?.path ?? ""));
      let rel = path.relative(this.realWorkspace(), this.realOf(abs)).split(path.sep).join("/");
      if (!isRelativeWorkspacePath(rel)) rel = path.relative(this.mission.workspace, abs).split(path.sep).join("/");
      if (!isRelativeWorkspacePath(rel)) throw new HarnessStoreError("unreadable", `"${call.args?.path}" cannot be recorded as a workspace path`);
      input.path = rel;
      input.before = this.hashOf(rel);
      input.expected = tool === "write_file" && typeof call.args?.content === "string" ? sha256(call.args.content) : null;
    } else {
      input.command = String(call.args?.command ?? "").slice(0, 2000);
    }
    const event = appendProof(this.mission.dir, input) as IntentEvent;
    this.effects.set(id, { intent: event, result: null, uncertain: null, resolved: null });
    this.point("before-effect");
    return { id, tool, abs };
  }

  /** Enregistre le résultat observé, après l'effet. Un résultat qui ne
   * s'écrit pas laisse l'intention seule au journal : à la prochaine
   * ouverture elle sera incertaine, et cette session n'agit plus. */
  end(h: EffectHandle, output: string): void {
    this.point("after-effect");
    const rec = this.effects.get(h.id);
    const after = h.abs && rec?.intent.path ? { after: this.hashOf(rec.intent.path) } : {};
    try {
      const event = appendProof(this.mission.dir, { type: "effect", fingerprint: this.mission.fingerprint, kind: "result", id: h.id, status: output.startsWith("Error") ? "error" : "ok", observed: observedLine(output), ...after });
      if (rec) rec.result = event as ResultEvent;
    } catch (err: any) {
      this.broken = `the result of effect ${h.id} could not be recorded (${err?.message ?? err})`;
    }
    this.point("after-receipt");
  }

  /** Résolution par l'hôte des effets incertains nommés : l'état actuel du
   * workspace est accepté comme base. `by` : une autorité de l'hôte, jamais
   * le modèle. Rend les identifiants résolus ; refuse un identifiant inconnu. */
  resolve(ids: string[], by: ApprovalAuthority): string[] {
    if (!APPROVAL_AUTHORITIES.includes(by)) throw new Error(`only the host resolves an uncertain action (${APPROVAL_AUTHORITIES.join(", ")})`);
    const r = this.state();
    if (r.journal !== "ok" && r.journal !== "absent") throw new Error(`the host journal is ${r.journal}: nothing can be resolved until it is repaired`);
    const done: string[] = [];
    for (const id of ids) {
      if (!EFFECT_ID_RE.test(id)) throw new Error(`"${id}" is not an effect identifier`);
      const rec = this.effects.get(id);
      if (!rec?.uncertain) throw new Error(`effect ${id} is not an uncertain action of this workspace`);
      if (rec.resolved) continue;
      rec.resolved = appendProof(this.mission.dir, { type: "effect", fingerprint: this.mission.fingerprint, kind: "resolved", id, by }) as ResolvedEvent;
      // L'état actuel du fichier visé devient l'état connu.
      if (rec.intent.path && this.known) {
        const h = this.hashOf(rec.intent.path);
        if (h === null) this.known.delete(rec.intent.path);
        else this.known.set(rec.intent.path, h);
      }
      done.push(id);
    }
    this.refresh();
    return done;
  }

  /** Reprise d'un transcript (web) : ce que le journal dit d'un appel d'outil
   * resté sans réponse, ou null pour le message générique. */
  explainCall(callId: string, name: string, args: Record<string, any> = {}): string | null {
    const effectCall = name === "write_file" || name === "edit_file" || name === "run_command" || (name === "task" && args?.action === "start");
    if (!effectCall) return null;
    const rec = [...this.effects.values()].filter((r) => r.intent.call === callId && r.intent.tool === name).pop();
    if (!rec) return `[Not executed: the session stopped before this ${name} ran — the host's effect journal has no record of it, and every effect is recorded before it happens. Nothing was changed by this call.]`;
    const i = rec.intent;
    if (rec.result) return `[Recovered from the host's effect journal (effect ${i.id}): this ${name} finished before the restart — ${rec.result.status}: ${rec.result.observed}. Do not run it again.]`;
    const u = rec.uncertain;
    const meaning = u ? meaningOf(u.evidence, i.tool) : "not yet reconciled";
    if (rec.resolved) return `[Effect ${i.id} (${name} ${describeTarget(i)}) had no recorded result after a restart; the host resolved it (${rec.resolved.by}): the workspace as it is now is the baseline. Evidence then: ${meaning}. Re-read the files before relying on them; do not assume it succeeded or failed.]`;
    return `[Outcome UNCERTAIN (effect ${i.id}, ${name} ${describeTarget(i)}): the session stopped between recording this action and recording its result. Evidence: ${meaning}. Writes and commands are suspended until the host resolves it; do not assume it failed or succeeded, and do not redo it on your own.]`;
  }

  /** Ce que la ligne `[resume]` du headless donne à lire. */
  summary() {
    const r = this.state();
    return {
      journal: r.journal,
      suspended: r.suspended,
      ...(r.reason ? { reason: r.reason } : {}),
      uncertain: r.uncertain.filter((u) => !u.resolved).map((u) => ({ id: u.id, tool: u.tool, target: u.target, evidence: u.evidence })),
      resolved: r.uncertain.filter((u) => u.resolved).map((u) => u.id),
      completed: r.completed,
      ...(r.orphans ? { orphans: r.orphans } : {}),
      ...(r.staleProofs.length ? { staleProofs: r.staleProofs } : {}),
      writer: this.writer,
      lock: r.lock,
      ...(r.external ? { external: r.external } : {}),
      ...(r.instructionsDrift.length ? { instructionsDrift: r.instructionsDrift } : {}),
    };
  }

  /** Les lignes que l'ouverture montre à l'humain. */
  lines(): string[] {
    const r = this.state();
    const out: string[] = [];
    if (r.lock.state === "busy") {
      const h = r.lock.holder;
      out.push(`· resume: another smolcoder session holds the writer lock for this workspace${h ? ` (${h.surface}, process ${h.pid}, since ${h.since})` : ""} — this session reads and plans; it takes the lock when that session ends`);
    } else if (r.lock.state === "unreadable") out.push(`· resume: the writer lock is unreadable (${r.lock.reason}) — writes are refused until it is repaired by hand`);
    else if (r.lock.state === "held" && r.lock.tookOver) out.push(`· resume: the previous writer (${r.lock.tookOver.surface}, process ${r.lock.tookOver.pid}, since ${r.lock.tookOver.since}) is gone; this session took its writer lock`);
    if (r.external) out.push(`· resume: the workspace changed since the last session (${describeExternal(r.external)}). These changes are preserved and are not the agent's; a file that changed is re-checked before any write, and the plan is re-anchored before the next one.`);
    if (r.instructionsDrift.length) out.push(`· resume: AGENTS.md changed since the last session under this contract (${r.instructionsDrift.join("; ")}): this new session reads the files on disk — a resumed web session keeps its own version`);
    if (r.journal === "truncated-tail" || r.journal === "unreadable" || r.journal === "unknown-schema") out.push(`· resume: ${r.reason}`);
    for (const u of r.uncertain.filter((x) => !x.resolved)) {
      out.push(`· resume: effect ${u.id} (${u.tool} ${u.target}, ${u.at}) has no recorded result — uncertain. Evidence: ${u.meaning}.`);
    }
    if (r.uncertain.some((u) => !u.resolved)) out.push("· resume: writes and commands are suspended until you resolve it: /resolve (headless: --resolve <id>). Nothing is replayed automatically.");
    if (r.orphans) out.push(`· resume: ${r.orphans} effect record(s) without their action were ignored`);
    if (r.staleProofs.length) out.push(`· resume: the files changed since ${r.staleProofs.join(", ")} passed — ${r.staleProofs.length > 1 ? "those proofs are" : "that proof is"} stale and count${r.staleProofs.length > 1 ? "" : "s"} as not run until checked again`);
    return out;
  }

  private point(p: CrashPoint): void {
    this.crash?.(p);
    if (process.env.SMOLCODER_TEST_CRASH_AT === p) process.kill(process.pid, "SIGKILL");
  }

  private realWorkspace(): string {
    try {
      return fs.realpathSync.native(this.mission.workspace);
    } catch {
      return this.mission.workspace;
    }
  }

  private realOf(abs: string): string {
    try {
      return fs.realpathSync.native(abs);
    } catch {
      try {
        return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
      } catch {
        return abs;
      }
    }
  }
}
