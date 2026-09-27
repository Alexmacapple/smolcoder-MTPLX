// Sondes internes de l'hôte (#18) : `node --check` et la compilation Python
// de ../tools/check.ts, `docker ps` / `podman ps` de ../detect.ts. Elles
// tournent sur l'hôte, hors de l'exécuteur isolé, même sous --mission : elles
// analysent sans exécuter et ne lancent que des programmes de l'hôte, avec des
// arguments fixes (décision et modèle de menace : docs/decision-backend-isole.md,
// « Sondes internes de l'hôte »). Leur seule porte vers le workspace était la
// recherche du programme : une entrée relative ou vide du PATH se résout
// depuis le dossier courant, souvent le workspace, où l'agent peut déposer un
// faux `python3` (mesuré : il tournait hors du bac). Elles cherchent donc leur
// programme dans les seules entrées absolues du PATH, hors des dossiers exclus
// (le workspace, quand il est connu), et partent d'un dossier courant neutre.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Le PATH d'une sonde : les entrées absolues, hors des dossiers exclus. */
export function hostProbePath(pathVar: string | undefined, exclude: string[] = []): string {
  const excluded = exclude.map(real);
  return (pathVar ?? "")
    .split(path.delimiter)
    .filter((p) => p && path.isAbsolute(p) && !excluded.some((d) => inside(real(p), d)))
    .join(path.delimiter);
}

/** Les workspaces du profil mission de ce processus : aucune sonde n'y cherche
 * ses programmes, même par une entrée absolue du PATH. La détection des
 * modèles ne connaît pas le workspace ; le point d'entrée l'inscrit ici. */
const missionWorkspaces = new Set<string>();

export function keepHostProbesOutOf(workspace: string): void {
  missionWorkspaces.add(real(workspace));
}

/** Options de lancement d'une sonde : l'environnement de l'hôte avec ce PATH
 * (une seule variable, quelle que soit sa casse sous Windows) et un dossier
 * courant neutre, jamais le workspace. */
export function hostProbeOptions(exclude: string[] = []): { env: NodeJS.ProcessEnv; cwd: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== "PATH") env[k] = v;
  env.PATH = hostProbePath(process.env.PATH, [...exclude, ...missionWorkspaces]);
  return { env, cwd: os.tmpdir() };
}
