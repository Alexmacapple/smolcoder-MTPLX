// Péremption de lecture (#19). L'agent édite un fichier d'après ce qu'il en a
// lu ; si le fichier a changé depuis — une personne, un autre processus, une
// tâche de fond, une commande qu'il a lancée —, son édition repose sur une
// vue périmée et peut écraser le travail d'un autre. Le suivi retient, fichier
// par fichier, le contenu que l'agent a vu en dernier (lu ou écrit par lui),
// et, juste avant une écriture, le compare au disque : s'il diffère, la
// première écriture est refusée avec la région changée, puis le nouvel état
// vaut comme vu — l'écriture suivante, faite en connaissance de cause, passe.
//
// Un signal, pas un verrou ni un journal d'effets : la détection des
// modifications concurrentes et le journal d'effets relèvent de #10. Le suivi
// vit dans la boucle de l'agent (le contexte d'outils de la session), en
// mémoire, et ne signale rien pour un fichier que l'agent n'a jamais vu.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { FileHooks } from "./fs-tools";

/** Au-delà, seule l'empreinte est gardée : le signal ne montre pas la région. */
const KEEP_CONTENT_CHARS = 256 * 1024;
const MAX_FILES = 500;
const REGION_LINES = 15;
const REGION_CHARS = 1200;

const STALE_MARK = "was changed on disk after you last read it";

/** Le retour d'une écriture refusée pour cause de lecture périmée. */
export function isStaleNotice(text: string): boolean {
  return text.startsWith("Error: ") && text.includes(STALE_MARK);
}

interface Seen {
  hash: string;
  content: string | null;
}

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** Même clé pour « a.js », « ./a.js » et un chemin passé par un lien — y
 * compris pour un fichier supprimé depuis, résolu par son dossier. */
function keyOf(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

/** La région qui diffère entre deux versions, par préfixe et suffixe communs. */
function changedRegion(before: string, after: string) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { from: p + 1, toNow: b.length - s, toBefore: a.length - s, now: b };
}

export class ReadTracker {
  private files = new Map<string, Seen>();

  /** L'agent vient de voir ce contenu (lecture, ou sa propre écriture). */
  note(abs: string, content: string): void {
    const key = keyOf(abs);
    this.files.delete(key); // le plus récent en dernier
    this.files.set(key, { hash: digest(content), content: content.length <= KEEP_CONTENT_CHARS ? content : null });
    for (const old of this.files.keys()) {
      if (this.files.size <= MAX_FILES) break;
      this.files.delete(old);
    }
  }

  /** Juste avant une écriture : null si le disque est tel que l'agent l'a vu
   * en dernier (ou s'il ne l'a jamais vu) ; sinon le signal à rendre à la
   * place de l'écriture, et le nouvel état vaut désormais comme vu. */
  check(abs: string, shownPath: string): string | null {
    const key = keyOf(abs);
    const seen = this.files.get(key);
    if (!seen) return null;
    let now: string;
    try {
      now = fs.readFileSync(abs, "utf8");
    } catch {
      this.files.delete(key);
      return (
        `Error: "${shownPath}" ${STALE_MARK}: it was deleted or moved (by a command, a background task, another process or a person). ` +
        `No file was changed. Check that it is still wanted before creating it again; the next write will be applied.`
      );
    }
    if (digest(now) === seen.hash) return null;
    this.note(abs, now);
    let region = "";
    if (seen.content !== null) {
      const r = changedRegion(seen.content, now);
      if (r.toNow >= r.from) {
        const shown = r.now.slice(r.from - 1, Math.min(r.toNow, r.from - 1 + REGION_LINES)).join("\n");
        const cut = r.toNow - r.from + 1 > REGION_LINES || shown.length > REGION_CHARS ? "\n[region shortened]" : "";
        const was = r.toBefore >= r.from ? (r.toBefore === r.from ? `line ${r.from}` : `lines ${r.from}-${r.toBefore}`) : "nothing there";
        region =
          `\nChanged region, now ${r.toNow === r.from ? `line ${r.from}` : `lines ${r.from}-${r.toNow}`} (before: ${was}):\n---\n` +
          `${shown.slice(0, REGION_CHARS)}${cut}\n---`;
      } else {
        region = `\nLines ${r.from}-${r.toBefore} that you read were removed; the file now has ${r.now.length} lines.`;
      }
    }
    return (
      `Error: "${shownPath}" ${STALE_MARK} (by a command, a background task, another process or a person). ` +
      `Your view of it is out of date, so this write was not applied. No file was changed, and nobody else's change was overwritten.` +
      region +
      `\nCheck that your change still fits the current file (read_file ${JSON.stringify({ path: shownPath })} if needed), then retry: the next write to this file will be applied.`
    );
  }

  /** Nouvelle conversation : ce que l'ancienne a vu ne compte plus. */
  clear(): void {
    this.files.clear();
  }

  /** La vue de l'agent, pour une sauvegarde de session (#10) : chemin réel du
   * fichier vers l'empreinte de ce qu'il a vu en dernier. */
  entries(): Array<[string, string]> {
    return [...this.files].map(([abs, s]) => [abs, s.hash]);
  }

  /** Reprise (#10) : l'agent avait vu ce contenu, dont seule l'empreinte est
   * gardée ; le disque qui en diffère donnera le même signal qu'en cours de
   * session, sans la région (le contenu vu n'est plus là). */
  noteHash(abs: string, hash: string): void {
    const key = keyOf(abs);
    this.files.delete(key);
    this.files.set(key, { hash, content: null });
    for (const old of this.files.keys()) {
      if (this.files.size <= MAX_FILES) break;
      this.files.delete(old);
    }
  }

  /** Les crochets que les outils de fichiers appellent (lecture, écriture). */
  hooks(): FileHooks {
    return {
      seen: (abs, content) => this.note(abs, content),
      beforeWrite: (abs, shownPath) => this.check(abs, shownPath),
    };
  }
}
