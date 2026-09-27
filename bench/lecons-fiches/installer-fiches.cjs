#!/usr/bin/env node
// Installe une variante des fiches (A ou B) dans le dossier personnel de test,
// avec le code de production du binaire figé : installFiches() de dist/fiches.js,
// celui qu'appelle `smol --install-fiches`, mais avec une source explicite. Le
// dossier personnel réel n'est jamais nommé ici. Sortie : un JSON sur stdout
// (fiches servies avec leur empreinte, empreinte de l'index du prompt).
// Usage : installer-fiches.cjs <dossier dist> <source des fiches> <dossier cible>
"use strict";
const crypto = require("crypto");
const path = require("path");

const [dist, source, cible] = process.argv.slice(2);
if (!dist || !source || !cible) {
  console.error("Usage : installer-fiches.cjs <dossier dist> <source des fiches> <dossier cible>");
  process.exit(2);
}
const fiches = require(path.resolve(dist, "fiches.js"));
try {
  fiches.installFiches(path.resolve(source), path.resolve(cible));
} catch (erreur) {
  console.error(`Installation refusée : ${erreur && erreur.message ? erreur.message : erreur}`);
  process.exit(1);
}
const lu = fiches.readManifest(path.resolve(cible));
if (lu.state !== "ok") {
  console.error(`Manifeste illisible après installation : ${lu.state}`);
  process.exit(1);
}
const index = fiches.fichesIndexBlock(lu.manifest);
process.stdout.write(
  JSON.stringify(
    {
      fiches: lu.manifest.fiches.map((f) => ({ name: f.name, summary: f.summary, sha256: f.sha256 })),
      index_sha256: crypto.createHash("sha256").update(index).digest("hex"),
      index,
    },
    null,
    2
  ) + "\n"
);
