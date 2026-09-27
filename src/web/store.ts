// On-disk memory for the web hub: saved sessions (so the sidebar survives a
// restart and any session can be resumed) and the list of workspaces the
// user has opened. Plain JSON files under ~/.smolcoder/, one pair per session:
// a small .meta.json that is read at startup, and the heavy transcript body
// that is only loaded when a session is resumed.

import * as fs from "fs";
import * as path from "path";
import { readSnapshot, SessionSnapshot } from "../session-state";

export type Event = Record<string, any>;

export interface SessionMeta {
  id: string;
  workspace: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  backend?: string;
}

export interface SessionBody {
  snapshot: SessionSnapshot;
  /** The UI event replay, so a resumed session shows its transcript. */
  events: Event[];
}

/** Lecture d'un transcript sauvegardé (#10) : absent, lisible (v2, ou v1
 * antérieur à #10 et migré en mémoire), écrit par un smol plus récent, ou
 * illisible — ces deux derniers jamais repris, jamais réécrits. */
export type BodyRead =
  | { state: "absent" }
  | { state: "ok"; body: SessionBody; legacy: boolean }
  | { state: "unknown-schema"; schema: unknown }
  | { state: "unreadable"; reason: string };

export function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function writeAtomicAsync(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

export class SessionStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.meta.json`);
  }

  private bodyPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  listMetas(): SessionMeta[] {
    const out: SessionMeta[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const n of names) {
      if (!n.endsWith(".meta.json")) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.dir, n), "utf8"));
        if (m && typeof m.id === "string" && typeof m.workspace === "string") {
          out.push({
            id: m.id,
            workspace: m.workspace,
            title: String(m.title ?? ""),
            createdAt: Number(m.createdAt) || 0,
            updatedAt: Number(m.updatedAt) || 0,
            model: m.model,
            backend: m.backend,
          });
        }
      } catch {
        /* skip a broken file */
      }
    }
    return out;
  }

  saveMeta(meta: SessionMeta): void {
    writeAtomic(this.metaPath(meta.id), JSON.stringify(meta));
  }

  saveBody(id: string, body: SessionBody): Promise<void> {
    return writeAtomicAsync(this.bodyPath(id), JSON.stringify(body));
  }

  saveBodySync(id: string, body: SessionBody): void {
    writeAtomic(this.bodyPath(id), JSON.stringify(body));
  }

  loadBody(id: string): SessionBody | null {
    const read = this.readBody(id);
    return read.state === "ok" ? read.body : null;
  }

  /** Le transcript et son état de lecture (#10). */
  readBody(id: string): BodyRead {
    let text: string;
    try {
      text = fs.readFileSync(this.bodyPath(id), "utf8");
    } catch (err: any) {
      return err?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", reason: String(err?.message ?? err) };
    }
    let b: any;
    try {
      b = JSON.parse(text);
    } catch (err: any) {
      return { state: "unreadable", reason: `not valid JSON (${err?.message ?? err})` };
    }
    if (!b || typeof b !== "object" || !b.snapshot) return { state: "unreadable", reason: "no saved session inside" };
    const snap = readSnapshot(b.snapshot);
    if (snap.state === "unknown-schema") return { state: "unknown-schema", schema: snap.schema };
    if (snap.state === "unreadable") return { state: "unreadable", reason: snap.reason };
    return { state: "ok", body: { snapshot: b.snapshot, events: Array.isArray(b.events) ? b.events : [] }, legacy: snap.schema !== "smolcoder/session/v2" };
  }

  /** Migration prudente (#10) : avant la première réécriture au nouveau
   * format, l'original d'une session antérieure est copié à côté, jamais
   * écrasé. Rend le chemin de la copie. */
  archiveLegacy(id: string): string {
    const copy = path.join(this.dir, `${id}.v1.json`);
    try {
      fs.copyFileSync(this.bodyPath(id), copy, fs.constants.COPYFILE_EXCL);
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
    return copy;
  }

  /** Un transcript illisible n'est jamais écrasé par la session qui repart
   * vide : il est mis de côté sous un autre nom. Rend ce nom. */
  quarantine(id: string): string {
    const kept = path.join(this.dir, `${id}.unreadable-${Date.now()}.json`);
    fs.renameSync(this.bodyPath(id), kept);
    return kept;
  }

  /** Suppression demandée par l'humain : la session et ses copies. */
  delete(id: string): void {
    let extra: string[] = [];
    try {
      extra = fs.readdirSync(this.dir).filter((n) => n === `${id}.v1.json` || (n.startsWith(`${id}.unreadable-`) && n.endsWith(".json"))).map((n) => path.join(this.dir, n));
    } catch {
      /* dossier absent */
    }
    for (const p of [this.metaPath(id), this.bodyPath(id), ...extra]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }
}

export interface WorkspaceEntry {
  path: string;
  addedAt: number;
  lastOpened: number;
}

/** Normalized form for comparisons: resolved, no trailing separator, and
 * case-folded on Windows where paths are case-insensitive. */
export function workspaceKey(p: string): string {
  let r = path.resolve(p);
  if (r.length > 1 && /[\\/]$/.test(r) && path.dirname(r) !== r) r = r.slice(0, -1);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export class WorkspaceStore {
  private readonly file: string;
  private entries: WorkspaceEntry[] = [];

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "workspaces.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(raw)) {
        this.entries = raw
          .filter((e: any) => e && typeof e.path === "string")
          .map((e: any) => ({ path: e.path, addedAt: Number(e.addedAt) || 0, lastOpened: Number(e.lastOpened) || 0 }));
      }
    } catch {
      this.entries = [];
    }
  }

  list(): WorkspaceEntry[] {
    return this.entries.slice();
  }

  has(p: string): boolean {
    const key = workspaceKey(p);
    return this.entries.some((e) => workspaceKey(e.path) === key);
  }

  add(p: string): WorkspaceEntry {
    const key = workspaceKey(p);
    let e = this.entries.find((x) => workspaceKey(x.path) === key);
    if (!e) {
      e = { path: path.resolve(p), addedAt: Date.now(), lastOpened: Date.now() };
      this.entries.push(e);
    } else {
      e.lastOpened = Date.now();
    }
    this.save();
    return e;
  }

  touch(p: string): void {
    const key = workspaceKey(p);
    const e = this.entries.find((x) => workspaceKey(x.path) === key);
    if (e) {
      e.lastOpened = Date.now();
      this.save();
    }
  }

  remove(p: string): void {
    const key = workspaceKey(p);
    this.entries = this.entries.filter((x) => workspaceKey(x.path) !== key);
    this.save();
  }

  private save(): void {
    try {
      writeAtomic(this.file, JSON.stringify(this.entries, null, 2));
    } catch {
      /* non-fatal */
    }
  }
}
