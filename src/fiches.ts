// Fiches de méthode installées côté hôte (ticket #30,
// docs/decision-fiches-hote.md) — seul module propriétaire de la grammaire de
// ~/.smolcoder/fiches/ : les copies `<nom>.md` et le manifeste `fiches.json`
// qui les liste avec leur empreinte. Une seule source : docs/skills/ du fork,
// copié par la commande explicite `smol --install-fiches`. Quand des fiches
// sont installées, le prompt en porte un index court et read_file les sert
// en lecture seule par une exception nommée et étroite : `fiche:<nom>`, un
// nom du manifeste, un fichier ordinaire (jamais un lien) dont le contenu a
// encore l'empreinte de l'installation. Rien d'autre du dossier ne s'ouvre,
// et les commandes n'y gagnent aucun accès : ~/.smolcoder reste refusé au bac
// isolé (hostPaths, src/harness/sandbox-executor.ts). Fail-closed : un
// manifeste illisible ou de schéma inconnu n'active rien et avertit
// l'utilisateur, jamais le modèle.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "./config";

export const FICHES_SCHEMA = "smolcoder/fiches/v1";
export const FICHES_MANIFEST = "fiches.json";
/** Le préfixe réservé du chemin de read_file qui désigne une fiche. */
export const FICHE_PREFIX = "fiche:";
export const FICHE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Bornes dures : une fiche est une page, pas un livre. */
export const MAX_FICHE_BYTES = 64 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_FICHES = 30;
export const SUMMARY_MAX = 120;
/** Le sommaire de docs/skills/ : il nomme les fiches, il n'en est pas une. */
const SOURCE_INDEX = "index.md";
const MANIFEST_FIELDS = ["schema", "source", "installedAt", "fiches"];
const ENTRY_FIELDS = ["name", "summary", "sha256"];
const HEX64 = /^[0-9a-f]{64}$/;

export interface FicheEntry {
  name: string;
  /** Quand lire la fiche, en une ligne, tirée de docs/skills/index.md. */
  summary: string;
  /** SHA-256 du contenu installé : la version exacte de la fiche. */
  sha256: string;
}

export interface FichesManifest {
  schema: typeof FICHES_SCHEMA;
  /** Chemin réel du docs/skills/ copié. Pas de révision git : la lire
   * lancerait un processus hors de l'exécuteur (#15), et l'arbre de travail
   * peut différer du commit ; l'empreinte de chaque fiche fait foi. */
  source: string;
  installedAt: string;
  fiches: FicheEntry[];
}

export type ManifestRead =
  | { state: "absent" }
  | { state: "unreadable"; reason: string }
  | { state: "unknown-schema"; schema: unknown }
  | { state: "ok"; manifest: FichesManifest };

export type FicheRead =
  | { ok: true; name: string; file: string; sha256: string; content: string }
  | { ok: false; error: string };

/** Ce qu'une session reçoit de l'installation : le dossier servi (null =
 * exception inactive), l'index du prompt, et ce qu'il faut dire à
 * l'utilisateur. */
export interface HostFiches {
  dir: string | null;
  index: string | null;
  count: number;
  warnings: string[];
}

export interface InstallResult {
  dir: string;
  source: string;
  fiches: FicheEntry[];
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Écriture atomique (fichier temporaire puis renommage, motif de
 * src/web/store.ts), octet pour octet : l'empreinte porte sur les octets. Le
 * renommage remplace l'entrée elle-même, même si c'est un lien. */
function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function fichesDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "fiches");
}

/** docs/skills/ du paquet dont ce binaire fait partie : le clone du fork
 * (npm link). Seule source acceptée par la commande d'installation. */
export function packageSkillsDir(): string {
  return path.resolve(__dirname, "..", "docs", "skills");
}

// ---- manifeste ----

function checkManifest(raw: Record<string, unknown>): FichesManifest {
  const bad = (why: string): never => {
    throw new Error(why);
  };
  for (const key of Object.keys(raw)) if (!MANIFEST_FIELDS.includes(key)) bad(`unknown field "${key}"`);
  if (typeof raw.source !== "string" || !path.isAbsolute(raw.source)) bad('field "source" must be an absolute path');
  if (typeof raw.installedAt !== "string" || Number.isNaN(Date.parse(raw.installedAt))) bad('field "installedAt" must be a date');
  if (!Array.isArray(raw.fiches) || raw.fiches.length > MAX_FICHES) bad(`field "fiches" must be a list of at most ${MAX_FICHES} entries`);
  const seen = new Set<string>();
  const entries = (raw.fiches as unknown[]).map((e, i) => {
    if (!isObject(e)) return bad(`fiche ${i + 1} must be an object`);
    for (const key of Object.keys(e)) if (!ENTRY_FIELDS.includes(key)) bad(`fiche ${i + 1}: unknown field "${key}"`);
    if (typeof e.name !== "string" || !FICHE_NAME_RE.test(e.name) || e.name === "index" || seen.has(e.name)) bad(`fiche ${i + 1}: invalid or repeated name`);
    // Le résumé entre dans le prompt : une seule ligne, sans caractère de contrôle.
    if (typeof e.summary !== "string" || !e.summary.trim() || e.summary.length > SUMMARY_MAX || /[\x00-\x1f\x7f]/.test(e.summary)) bad(`fiche ${i + 1}: "summary" must be one line of at most ${SUMMARY_MAX} characters`);
    if (typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) bad(`fiche ${i + 1}: "sha256" must be 64 hexadecimal characters`);
    seen.add(e.name as string);
    return { name: e.name as string, summary: e.summary as string, sha256: e.sha256 as string };
  });
  return { schema: FICHES_SCHEMA, source: raw.source as string, installedAt: raw.installedAt as string, fiches: entries };
}

/** Le manifeste des fiches installées. Le dossier doit être un vrai dossier :
 * un lien symbolique à sa place n'est pas une installation. */
export function readManifest(dir: string): ManifestRead {
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: String(err?.message ?? err) };
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { state: "unreadable", reason: `${dir} is not a plain folder` };
  const file = path.join(dir, FICHES_MANIFEST);
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_MANIFEST_BYTES) return { state: "unreadable", reason: `${FICHES_MANIFEST} exceeds ${MAX_MANIFEST_BYTES} bytes` };
    text = fs.readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: String(err?.message ?? err) };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err: any) {
    return { state: "unreadable", reason: `${FICHES_MANIFEST} is not valid JSON (${err?.message ?? err})` };
  }
  if (!isObject(data)) return { state: "unreadable", reason: `${FICHES_MANIFEST} is not a JSON object` };
  if (data.schema !== FICHES_SCHEMA) return { state: "unknown-schema", schema: data.schema };
  try {
    return { state: "ok", manifest: checkManifest(data) };
  } catch (err: any) {
    return { state: "unreadable", reason: `${FICHES_MANIFEST}: ${err?.message ?? err}` };
  }
}

// ---- lecture : l'exception nommée de read_file ----

/** Un chemin de read_file qui désigne une fiche (préfixe réservé). */
export function isFicheRef(p: unknown): boolean {
  return typeof p === "string" && p.trim().toLowerCase().startsWith(FICHE_PREFIX);
}

/** Lit une fiche installée, désignée par `fiche:<nom>` (`.md` toléré). Seuls
 * les noms du manifeste s'ouvrent ; le fichier doit être ordinaire (jamais
 * suivi s'il est un lien) et avoir encore l'empreinte de l'installation. */
export function readInstalledFiche(dir: string, ref: unknown): FicheRead {
  const refused = (error: string): FicheRead => ({ ok: false, error });
  const shown = String(ref);
  const m = readManifest(dir);
  if (m.state !== "ok") return refused(`the method sheets of this host are ${m.state === "absent" ? "no longer installed" : m.state}, so "${shown}" cannot be read. Continue without it.`);
  const names = m.manifest.fiches.map((f) => f.name);
  const choices = names.map((n) => `${FICHE_PREFIX}${n}`).join(", ");
  let name = typeof ref === "string" ? ref.trim().slice(FICHE_PREFIX.length).toLowerCase() : "";
  if (name.endsWith(".md")) name = name.slice(0, -3);
  if (!FICHE_NAME_RE.test(name)) {
    return refused(`"${shown}" is not a method sheet name. Use one of ${choices} — nothing else outside the workspace is readable.`);
  }
  const entry = m.manifest.fiches.find((f) => f.name === name);
  if (!entry) return refused(`no installed method sheet is named "${name}". Installed: ${choices}.`);
  const file = path.join(dir, `${name}.md`);
  const notRegular = `the method sheet "${name}" is not a regular file (a symbolic link or another kind of entry): it is not served. Reinstall the sheets with smol --install-fiches.`;
  try {
    // Vaut aussi là où O_NOFOLLOW n'existe pas (Windows).
    if (!fs.lstatSync(file).isFile()) return refused(notRegular);
  } catch (err: any) {
    return refused(`the method sheet "${name}" cannot be opened (${err?.code ?? err}). Reinstall the sheets with smol --install-fiches.`);
  }
  let fd: number;
  try {
    // O_NOFOLLOW : un lien posé à la place de la fiche n'est jamais suivi,
    // même s'il apparaît entre la vérification et la lecture.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err: any) {
    if (err?.code === "ELOOP") return refused(notRegular);
    return refused(`the method sheet "${name}" cannot be opened (${err?.code ?? err}). Reinstall the sheets with smol --install-fiches.`);
  }
  let content: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return refused(notRegular);
    if (stat.size > MAX_FICHE_BYTES) return refused(`the method sheet "${name}" exceeds ${MAX_FICHE_BYTES} bytes: it is not served.`);
    content = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = fs.readSync(fd, content, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    content = content.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
  const hash = sha256(content);
  if (hash !== entry.sha256) {
    return refused(`the method sheet "${name}" changed since it was installed (its SHA-256 no longer matches the manifest): it is not served. Reinstall the sheets with smol --install-fiches.`);
  }
  return { ok: true, name, file, sha256: hash, content: content.toString("utf8") };
}

// ---- index du prompt ----

/** L'index court injecté dans le prompt : une ligne par fiche, et l'appel
 * exact à imiter. */
export function fichesIndexBlock(manifest: FichesManifest): string {
  const example = manifest.fiches[0]?.name ?? "name";
  return [
    `Method sheets (fiches) installed on this host, outside the workspace and read-only. Before a task that matches one, read it with read_file, for example {"path": "${FICHE_PREFIX}${example}"}:`,
    ...manifest.fiches.map((f) => `- ${f.name}: ${f.summary}`),
  ].join("\n");
}

/** Le workspace annonce déjà ses propres fiches (le dépôt smolcoder : un
 * sommaire docs/skills/index.md et un AGENTS.md qui y renvoie) : l'hôte n'y
 * ajoute pas un second index. */
function announcesOwnFiches(workspace: string, workspaceAgentsMd: string | null): boolean {
  return !!workspaceAgentsMd?.includes("docs/skills/") && fs.existsSync(path.join(workspace, "docs", "skills", SOURCE_INDEX));
}

/** Les fiches d'une session, décidées à son ouverture : sans installation,
 * rien — ni index, ni exception, ni message au modèle. */
export function loadHostFiches(workspace: string, workspaceAgentsMd: string | null, dir: string = fichesDir()): HostFiches {
  const none: HostFiches = { dir: null, index: null, count: 0, warnings: [] };
  if (process.env.SMOL_NO_FICHES === "1") return none;
  if (announcesOwnFiches(workspace, workspaceAgentsMd)) return none;
  const read = readManifest(dir);
  if (read.state === "absent") return none;
  if (read.state !== "ok") {
    const why = read.state === "unknown-schema" ? `stored with an unknown schema (${JSON.stringify(read.schema)})` : `unreadable (${read.reason})`;
    return { ...none, warnings: [`method sheets in ${dir} are ${why} — no index this session; reinstall them with smol --install-fiches`] };
  }
  if (!read.manifest.fiches.length) return none;
  return { dir, index: fichesIndexBlock(read.manifest), count: read.manifest.fiches.length, warnings: [] };
}

// ---- installation ----

/** Le résumé d'une entrée de docs/skills/index.md : le texte après le tiret,
 * jusqu'au premier deux-points ou à la fin de la première phrase. */
function summaryOf(description: string): string {
  let s = description.replace(/\s+/g, " ").trim();
  const colon = s.search(/[\s  ]:/);
  if (colon > 0) s = s.slice(0, colon);
  const stop = s.search(/\.(\s|$)/);
  if (stop > 0) s = s.slice(0, stop);
  s = s.trim();
  if (s.length > SUMMARY_MAX) s = s.slice(0, s.lastIndexOf(" ", SUMMARY_MAX - 1)).trim() + "…";
  return s;
}

/** Les entrées de docs/skills/index.md : `- \`<nom>.md\` — description`, la
 * description pouvant continuer sur les lignes indentées qui suivent. */
function parseSkillsIndex(text: string): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  let current: { name: string; description: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^- `([^`]+)\.md` — (.*)$/.exec(line);
    if (m) {
      current = { name: m[1], description: m[2] };
      out.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.description += " " + line.trim();
    } else {
      current = null;
    }
  }
  return out;
}

/** Copie les fiches de `source` (docs/skills/ du fork) dans `dir`. Tout est
 * vérifié avant la première écriture : chaque fiche du sommaire existe, est
 * un fichier ordinaire sous la borne, et chaque fiche du dossier figure au
 * sommaire. Les fiches d'abord, le manifeste en dernier (écritures
 * atomiques) : tant que le manifeste n'est pas écrit, l'installation
 * précédente reste la seule servie. */
export function installFiches(source: string, dir: string = fichesDir()): InstallResult {
  let src: string;
  try {
    src = fs.realpathSync.native(source);
  } catch {
    throw new Error(`no docs/skills folder at ${source}: method sheets are installed from a clone of the fork (npm link), whose docs/skills/ is their only source`);
  }
  const indexFile = path.join(src, SOURCE_INDEX);
  if (!fs.existsSync(indexFile)) throw new Error(`${indexFile} is missing: the sheets' summary is their list`);
  const entries = parseSkillsIndex(fs.readFileSync(indexFile, "utf8"));
  if (!entries.length) throw new Error(`${indexFile} lists no method sheet (lines "- \`<name>.md\` — …")`);
  if (entries.length > MAX_FICHES) throw new Error(`${indexFile} lists more than ${MAX_FICHES} method sheets`);
  const seen = new Set<string>();
  const files: Array<{ entry: FicheEntry; content: Buffer }> = [];
  for (const { name, description } of entries) {
    if (!FICHE_NAME_RE.test(name) || name === "index") throw new Error(`${name}.md: a method sheet name is lowercase letters, digits and "-"`);
    if (seen.has(name)) throw new Error(`${name}.md is listed twice in ${SOURCE_INDEX}`);
    seen.add(name);
    const file = path.join(src, `${name}.md`);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new Error(`${name}.md is listed in ${SOURCE_INDEX} but missing from ${src}`);
    }
    if (!stat.isFile()) throw new Error(`${name}.md in ${src} is not a regular file`);
    if (stat.size > MAX_FICHE_BYTES) throw new Error(`${name}.md exceeds ${MAX_FICHE_BYTES} bytes`);
    const summary = summaryOf(description);
    if (!summary) throw new Error(`${name}.md has no description in ${SOURCE_INDEX}`);
    const content = fs.readFileSync(file);
    files.push({ entry: { name, summary, sha256: sha256(content) }, content });
  }
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith(".md") && f !== SOURCE_INDEX && !seen.has(f.slice(0, -3))) {
      throw new Error(`${f} is in ${src} but not listed in ${SOURCE_INDEX}: the summary and the sheets must agree before installing`);
    }
  }
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symbolic link: remove it, the sheets are installed as copies`);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const { entry, content } of files) writeFileAtomic(path.join(dir, `${entry.name}.md`), content);
  const manifest: FichesManifest = {
    schema: FICHES_SCHEMA,
    source: src,
    installedAt: new Date().toISOString(),
    fiches: files.map((f) => f.entry),
  };
  writeFileAtomic(path.join(dir, FICHES_MANIFEST), JSON.stringify(checkManifest(JSON.parse(JSON.stringify(manifest))), null, 2) + "\n");
  return { dir, source: src, fiches: manifest.fiches };
}
