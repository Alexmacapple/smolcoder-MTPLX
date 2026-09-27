// Rapporteur node:test de la campagne OS (#18) : une ligne JSON par test de
// premier niveau — nom, fichier, statut (pass, fail, skip, todo, cancelled),
// durée en millisecondes et première ligne de l'erreur. Les sous-tests sont
// comptés dans leur test parent. Usage :
//   node --test --test-reporter=bench/campagne-os/rapporteur.mjs \
//     --test-reporter-destination=<fichier.jsonl> <fichiers>
import path from "node:path";

export default async function* rapporteur(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data;
    if (data.nesting !== 0 || data.details?.type === "suite") continue;
    let status = event.type === "test:pass" ? "pass" : "fail";
    if (data.skip !== undefined && data.skip !== false) status = "skip";
    else if (data.todo !== undefined && data.todo !== false) status = "todo";
    const error = data.details?.error;
    if (status === "fail" && /cancel/i.test(String(error?.failureType ?? ""))) status = "cancelled";
    const cause = error?.cause ?? error;
    const message = cause ? String(cause.message ?? cause).split("\n")[0] : undefined;
    yield JSON.stringify({
      name: data.name,
      file: data.file ? path.relative(process.cwd(), data.file) : null,
      status,
      duration_ms: Math.round((data.details?.duration_ms ?? 0) * 1000) / 1000,
      ...(status === "fail" || status === "cancelled" ? { error: message } : {}),
    }) + "\n";
  }
}
