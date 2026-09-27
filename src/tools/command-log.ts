// Retours de commande exploitables (#19). Un long journal de test ou de build
// ne tient pas dans le contexte d'un petit modèle : il est raccourci, mais la
// cause décisive — le test en échec, l'exception, l'erreur de compilation —
// ne doit jamais disparaître avec le milieu. Deux pièces :
//   - shortenLog : garde le début et la fin, et remonte EN TÊTE les lignes
//     décisives trouvées dans la partie omise ; en tête, parce qu'une coupe
//     ultérieure au milieu (plafond du contexte, note de compaction) garde le
//     début d'un texte ;
//   - CommandLogs : le journal complet des dernières sorties raccourcies,
//     gardé en mémoire par la session et lu par read_file sous le nom
//     `log:<n>` — lecture ciblée, jamais écrite dans le workspace (les
//     empreintes du profil mission n'en voient rien).

/** Lignes qui portent d'ordinaire la cause d'un échec. */
const DECISIVE: RegExp[] = [
  /^\s*not ok\b/, // TAP, node:test
  /[✖✗✘]/, // node:test, mocha
  /(?:^|\s)×\s/, // vitest
  /\bFAIL(?:ED|URE)?\b/, // jest, pytest, go test
  /\b[A-Z]\w*(?:Error|Exception)\b/, // AssertionError, TypeError, RuntimeException
  /\bError\b(?:\s*\[[^\]]*\])?:/, // « Error: … », « Error [ERR_X]: … »
  /\berror(?:\[\w+\])?(?:\s+TS\d+)?\s*:/i, // tsc, rustc, gcc
  /^\s*(?:Traceback\b|panic:|fatal:|FATAL\b)/,
  /^E\s{2,}\S/, // pytest
  /^\s*(?:Expected|Received)\b.*:/, // jest
  /\b[1-9]\d* (?:failing|failed|errors?)\b/, // mocha, résumés
  /^npm (?:ERR!|error)\b/,
];

export function isDecisive(line: string): boolean {
  return DECISIVE.some((re) => re.test(line));
}

const MAX_DECISIVE = 12;
const DECISIVE_LINE_CHARS = 200;

export interface ShortLog {
  text: string;
  shortened: boolean;
  /** Première ligne décisive remontée (1 = première ligne du journal). */
  focus: number | null;
}

/** Le journal dans `budget` caractères : tel quel s'il tient ; sinon début et
 * fin coupés sur des fins de ligne, et — quand `failure` — les lignes
 * décisives de la partie omise, numérotées, en tête. */
export function shortenLog(log: string, budget: number, failure: boolean): ShortLog {
  if (log.length <= budget) return { text: log, shortened: false, focus: null };
  const lines = log.split("\n");
  const cut = (reserve: number) => {
    const room = Math.max(0, budget - reserve - 100);
    const headRoom = Math.floor(room * 0.6);
    const tailRoom = room - headRoom;
    let h = 0;
    for (let used = 0; h < lines.length && used + lines[h].length + 1 <= headRoom; h++) used += lines[h].length + 1;
    let t = 0;
    for (let used = 0; t < lines.length - h && used + lines[lines.length - 1 - t].length + 1 <= tailRoom; t++) used += lines[lines.length - 1 - t].length + 1;
    return { h, t, headRoom, tailRoom };
  };
  // Une place réservée aux lignes décisives seulement s'il y en a dans la
  // partie omise ; elle ne fait que l'agrandir, donc aucune n'y échappe. Même
  // une petite fenêtre garde la place d'une ou deux lignes décisives.
  const reserve = Math.max(Math.floor(budget * 0.35), Math.min(260, Math.floor(budget / 2)));
  let split = cut(reserve);
  const picked: { line: number; text: string }[] = [];
  let matching = 0;
  if (failure) {
    const seen = new Set<string>();
    let used = 0;
    for (let i = split.h; i < lines.length - split.t; i++) {
      if (!isDecisive(lines[i])) continue;
      matching++;
      const text = lines[i].trim();
      if (seen.has(text) || picked.length >= MAX_DECISIVE) continue;
      const shown = text.length > DECISIVE_LINE_CHARS ? text.slice(0, DECISIVE_LINE_CHARS) + "…" : text;
      const entry = `  line ${i + 1}: ${shown}`;
      // 80 : l'en-tête et la fin de la section.
      if (used + entry.length + 1 > reserve - 80) continue;
      seen.add(text);
      used += entry.length + 1;
      picked.push({ line: i + 1, text: entry });
    }
  }
  const section = picked.length
    ? `[Output shortened. Failure lines found in the omitted part${matching > picked.length ? ` (${picked.length} of ${matching} shown)` : ""}:\n${picked.map((p) => p.text).join("\n")}]\n`
    : "";
  // La place réservée et non prise revient au début et à la fin : la partie
  // omise ne fait que rétrécir, aucune ligne décisive n'y reste cachée.
  split = cut(section.length);
  const { h, t, headRoom, tailRoom } = split;
  // Une seule ligne plus longue que la place : on en montre un morceau.
  const head = h ? lines.slice(0, h).join("\n") : lines[0].slice(0, headRoom);
  const tail = t ? lines.slice(lines.length - t).join("\n") : tailRoom > 0 ? lines[lines.length - 1].slice(-tailRoom) : "";
  const omittedLines = Math.max(0, lines.length - h - t);
  const omittedChars = Math.max(0, log.length - head.length - tail.length);
  return {
    text: `${section}${head}\n... [${omittedLines} lines (${omittedChars} characters) omitted to save context] ...\n${tail}`,
    shortened: true,
    focus: picked.length ? picked[0].line : null,
  };
}

const LOG_PREFIX = /^\s*log:(\d+)\s*$/i;

/** `log:<n>` : un journal gardé par la session, jamais un fichier. */
export function isLogRef(p: unknown): boolean {
  return typeof p === "string" && LOG_PREFIX.test(p);
}

/** Les journaux complets des dernières sorties raccourcies, en mémoire. */
export class CommandLogs {
  private logs = new Map<number, string>();
  private counter = 0;

  constructor(private readonly keep = 6) {}

  /** Garde un journal ; rend son nom pour read_file. */
  add(text: string): string {
    const id = ++this.counter;
    this.logs.set(id, text);
    for (const old of this.logs.keys()) {
      if (this.logs.size <= this.keep) break;
      this.logs.delete(old);
    }
    return `log:${id}`;
  }

  get(ref: unknown): string | undefined {
    const m = typeof ref === "string" ? LOG_PREFIX.exec(ref) : null;
    return m ? this.logs.get(Number(m[1])) : undefined;
  }

  /** Nouvelle conversation : les journaux de l'ancienne ne servent plus ;
   * les numéros ne repartent pas de 1, pour qu'un ancien nom ne désigne
   * jamais un autre journal. */
  clear(): void {
    this.logs.clear();
  }

  get size(): number {
    return this.logs.size;
  }

  get kept(): number {
    return this.keep;
  }
}

/** Un journal ne s'écrit jamais : le modèle écrit dans le workspace. */
export function logReadOnly(p: unknown): string {
  return `Error: "${String(p)}" names a command log kept by the harness, which is read-only. Write to a workspace path instead.`;
}
