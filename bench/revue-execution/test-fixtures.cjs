#!/usr/bin/env node
// Vérifie les vérités terrain des trois cas avant leur pré-enregistrement.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;

function loadFixture(name, candidate) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "revue-fixture-"));
  fs.cpSync(path.join(root, "fixtures", name, "base"), folder, { recursive: true });
  if (candidate) {
    fs.cpSync(path.join(root, "fixtures", name, "candidate"), folder, { recursive: true, force: true });
  }
  return { folder, module: require(path.join(folder, name === "tarif-zero" ? "invoice.js" : "reserve.js")) };
}

async function main() {
  for (const candidate of [false, true]) {
    const item = loadFixture("tarif-zero", candidate);
    try {
      assert.equal(item.module.amountFor("pro"), 2000);
      if (candidate) assert.throws(() => item.module.amountFor("free"), /Plan inconnu/);
      else assert.equal(item.module.amountFor("free"), 0);
      assert.throws(() => item.module.amountFor("absent"), /Plan inconnu/);
    } finally {
      fs.rmSync(item.folder, { recursive: true, force: true });
    }
  }
  for (const name of ["reservation-race", "reservation-protegee"]) {
    for (const candidate of [false, true]) {
      const item = loadFixture(name, candidate);
      try {
        const results = await Promise.all([item.module.reserve(), item.module.reserve()]);
        const expected = name === "reservation-race" && candidate ? [true, true] : [true, false];
        assert.deepEqual(results, expected, `${name}, candidate=${candidate}`);
      } finally {
        fs.rmSync(item.folder, { recursive: true, force: true });
      }
    }
  }
  process.stdout.write("PASS : trois vérités terrain vérifiées sur base et candidat\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
