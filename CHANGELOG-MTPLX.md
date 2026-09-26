# Journal des modifications — fork MTPLX

Fork de [leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder)
(MIT, crédit à Leon van Zyl). La version amont de référence est
`0.7.1` (commit `4ee47b5`, « Release smolcoder 0.7.1 »). Tout ce qui
figure ci-dessous est ajouté par ce fork le 26 septembre 2026.

## 2026-09-26

### `0fbdc40` — Lecture de la fenêtre de contexte réelle

`src/detect.ts` (2 lignes). La branche fallback « older LM Studio »
imposait 4 096 tokens à tout serveur non identifié nativement.
Maintenant, quand la liste OpenAI-compatible `/v1/models` rapporte
`context_length` (c'est le cas de MTPLX : 262 144 pour Qwen 3.8 27B
FP16), cette valeur est lue ; l'estimation 4 096 ne s'applique plus
qu'en son absence.

Vérifié en headless et en interface web : la session affiche
`ctx 262,144` (usage 1 361 tokens après un message, réserve de
réponse 8 192), contre 4 096 avant.

### `68fc460` — README préambule du fork

`README.md`. Bloc en français ajouté au-dessus du README amont
(conservé tel quel) : pourquoi le fork, la config `~/.smolcoder.json`
qui raccorde MTPLX, la description du patch, la commande
d'installation du fork.

### `ef7df9a` — `AGENTS.md` français

`AGENTS.md` à la racine : consignes de langage pour l'agent (réponses
en français, code et identifiants en anglais, commits conventionnels en
français), chargé à chaque session par smolcoder et conservé après
compactage.

### `659f266` — Lanceur macOS à la racine du fork

`launch-smol-mtplx.command` (copie du lanceur du workspace
`~/Claude/lanceurs/`). Interface web par défaut : le lanceur se
raccorde au démon par « smol --web » pour obtenir une URL fraîche —
la clé `?k=` lisible dans `~/.smolcoder-web.log` peut dater d'un
démon précédent et renvoyer 403 — puis l'ouvre dans le navigateur.
`<dossier>` raccorde ce dossier à l'interface, `--session [dossier]`
ouvre le terminal interactif, `--test` joue une requête headless de
contrôle.

Vérifié par exécution réelle : curl 403 sur la clé du log contre 200
sur une clé fraîche ; les quatre modes exécutés (expect sur TTY réel
pour `--session`).

### `ec6fb69`, `d46a96e` — Consignes globales `~/.smolcoder/AGENTS.md`

`src/prompt.ts`. smolcoder ne lisait que l'`AGENTS.md` du dossier de
travail : les règles communes devaient être recopiées dans chaque projet,
et un `AGENTS.md` de plus de 8 000 caractères perdait sa fin. Il charge
désormais d'abord `~/.smolcoder/AGENTS.md` (plafond 4 000 caractères),
puis celui du projet (plafond inchangé, 8 000), sans lire deux fois le
même fichier. Six tests dans `test/agents-md.test.js`, rouges sur les deux
cas de chargement global avant le correctif ; suite complète 152/152.

`docs/agents-md-global.md` : le noyau à installer comme
`~/.smolcoder/AGENTS.md`, dix commandements de l'agent de codage et deux
formules (Saint-Exupéry, Shannon), 1 908 caractères.

### `3cc57db` — README : le fork est la version de référence

`README.md` (2 lignes). Le patch n'est plus présenté comme candidat à
un pull request amont : ce fork est la version de référence pour
MTPLX, à installer à la place du paquet amont.

### `10d3db9` — Consigne de tenue du journal dans `AGENTS.md`

`AGENTS.md`, `CHANGELOG-MTPLX.md`. Toute modification du fork doit
désormais ajouter son entrée dans ce journal, dans le même commit.
SHA reportés sur les entrées qui n'en avaient pas (`ef7df9a`,
`ec6fb69`, `d46a96e`) ; entrées `659f266` et `3cc57db` ajoutées.

### `2245322` — Banc du noyau sur Qwen

`bench/noyau-agents-md/` (script et quatre consignes),
`docs/banc-noyau-agents-md-2026-09-26.md`. Mesure la conduite de
smolcoder avec et sans `~/.smolcoder/AGENTS.md` sur quatre scénarios
(bug, demande destructive, secret, ajout), un essai par cas sur MTPLX.
Avec le noyau, la demande destructive est refusée et la clé factice
n'est pas affichée ; sans lui, `git reset --hard` et `rm -rf` sont
exécutés et la clé est affichée. Bug et ajout réussis dans les deux cas.

### `ccd2215` — Règles du workspace reprises dans `AGENTS.md`

`AGENTS.md`. Delta du fork enrichi depuis le protocole du workspace
`~/Claude/AGENTS.md` : objectif sous contraintes et hypothèses nommées,
vérité et preuve (annonce avant action à impact, preuve après, échec
bruyant), changements (relire avant d'éditer, conventions montrables,
périmètre annoncé, SSH uniquement), modes d'échec à éviter. Le style
de commit passe de « conventionnel (`feat:`, `fix:`) » à la forme
nominale française, conforme à l'historique réel du dépôt ; l'ancienne
section « Travail » est fusionnée dans « Vérité et preuve ». Le noyau
global n'est pas répété : il est chargé depuis `~/.smolcoder/AGENTS.md`
(vérifié identique à `docs/agents-md-global.md` par `cmp`).
SHA `2245322` reporté sur l'entrée précédente (banc du noyau).

### `f1010d0` — Section Projet et dégraissage du delta

`AGENTS.md`. Section « Projet » ajoutée en tête : build obligatoire
après toute modification de `src/` (le binaire npm link et le démon
web servent `dist/`), `npm test` (build puis suite), surface du fork
(`src/detect.ts`, `src/prompt.ts`), `dist/` généré à ne jamais éditer,
critère de fin (suite verte et entrée au journal). Trois règles
retirées car déjà portées par le noyau global : relire avant d'éditer
(commandement 2), dire le non-vérifié (commandement 7), élargissement
de périmètre annoncé (couvert par le mode d'échec « plus grand bien
silencieux »). SHA `ccd2215` reporté sur l'entrée précédente.

### `6f859a9` — Correctifs issus de l'audit ShipGuard

`src/prompt.ts`, `src/detect.ts`, `test/agents-md.test.js`,
`test/detect.test.js`, `bench/noyau-agents-md/banc.sh`,
`launch-smol-mtplx.command`. Correctifs mécaniques et test-first tirés
de l'audit ShipGuard du fork (0 critique, 1 élevé, 22 moyens, 28 faibles).

- `prompt.ts` : la déduplication des deux AGENTS.md compare désormais
  l'identité de fichier (`realpathSync.native`), plus la chaîne de
  chemin. Un AGENTS.md de projet en lien vers le global, ou un
  workspace en lien vers `~/.smolcoder`, n'est plus lu deux fois.
- `detect.ts` : prédicat `context_length` dédupliqué (`hasCtx`),
  commentaire et note « older LM Studio » corrigés en
  « OpenAI-compat » (MTPLX passe par cette branche).
- `banc.sh` : arguments validés (usage, exit 2) avant tout montage ;
  `mktemp` et `cd` gardés par `|| exit 1` (le scénario ne peut plus
  s'exécuter dans le dossier appelant) ; constats comparés au commit
  de référence capturé avant le run, plus à l'index ; `exec ... or die`,
  timeout sur le test unitaire, empreinte du noyau enregistrée.
- `launch-smol-mtplx.command` : `~/.smolcoder.json` fusionné en Python
  (lastModel, effort et autres hôtes préservés) au lieu d'être écrasé ;
  `mtplx_ok` sans pipe fragile et identifiant exact ; garde MTPLX.app
  absente ; `--test` avec `trap` de nettoyage et timeout 300 s ;
  extraction d'URL restreinte au motif `?k=`.
- Tests : deux cas lien symbolique et un cas fichier illisible pour
  `loadAgentsMd` (rouges avant le correctif, verts après) ; deux cas de
  la branche compat `/v1/models` ; assertion du plafond global durcie à
  4 000 caractères exacts.

Vérifications : `npm test` 157/157 exit 0 (152 + 5 nouveaux) ; phase
rouge confirmée sur les tests lien symbolique ; gardes d'arguments du
banc éprouvées (exit 2) ; fusion de config prouvée sans perte et
idempotente ; lanceur `--web` rejoué (URL fraîche, exit 0). Les 12
constats à décision humaine restent ouverts (sens de `context_length`
selon le serveur, précédence des règles projet vs noyau, session par
lancement, course serveur de secours contre KeepAlive). SHA `f1010d0`
reporté sur l'entrée précédente.

### `ac7ad3e` — Bit exécutable préservé au build

`package.json`. Le script `build` régénérait `dist/index.js` sans le
bit exécutable (tsc n'en pose pas), ce qui cassait le binaire `smol`
(« permission denied ») après tout `npm run build` ou `npm test`. Le
script ajoute désormais `node -e "require('fs').chmodSync('dist/index.js', 0o755)"`,
sur le modèle du script `clean` (cross-platform, inoffensif sous
Windows). Vérifié : après `npm run build`, `dist/index.js` porte
`-rwxr-xr-x` et `smol --version` répond. SHA `6f859a9` reporté sur
l'entrée précédente.

### `a733bba` — Les onze correctifs test-first de l'audit

`src/detect.ts`, `src/prompt.ts`, `src/index.ts`, `src/session.ts`,
`test/detect.test.js`, `test/agents-md.test.js`,
`bench/noyau-agents-md/banc.sh`, `bench/.gitignore`,
`launch-smol-mtplx.command`. Solde des constats test-first de l'audit
ShipGuard, en rouge/vert.

- `detect.ts` : `context_length` accepté seulement s'il est un entier
  sûr d'au moins 1 024 (Infinity, fraction ou valeur minuscule
  retombent sur 4 096 avec note) ; une entrée `null` dans la liste
  compat ne fait plus tomber `identifyServer`.
- `prompt.ts` : `loadAgentsMdDetails` expose provenance et
  avertissements — fichier présent mais illisible signalé (plus de
  perte silencieuse des garde-fous), troncature annoncée à l'écran,
  coupe qui recule d'un caractère devant une paire de substitution
  UTF-16. `index.ts` affiche « Instructions loaded: global + workspace »
  au lieu du libellé trompeur ; `session.ts` relaie les avertissements.
- `banc.sh` : workspaces et HOME temporaires créés sous TMPDIR, hors
  du dépôt (un agent qui supprime `W/.git` ne fait plus remonter git
  au fork) ; `resultats/` ignoré par git ; timeout par SIGTERM au
  groupe de processus (node exécute son nettoyage, plus d'orphelins),
  KILL cinq secondes après en dernier recours.
- Lanceur : option inconnue, dossier introuvable ou argument
  surnuméraire rejetés avec usage (exit 2) ; `launchctl bootstrap`
  puis `kickstart` puis `load` en cascade, consigne d'arrêt en
  `bootout` ; attache `smol --web` bornée à 30 s ; `--test` sous le
  même wrapper SIGTERM.

Vérifications : phase rouge 6/6 (Infinity traversait, TypeError sur
null, API details absente, demi-substitution coupée) puis suite
163/163 exit 0 ; wrapper prouvé (rc 143, zéro processus survivant du
groupe, exec raté rc 2) ; cas négatifs du lanceur exit 2 ; démon
déchargé par bootout puis rechargé par le lanceur (bootstrap), URL
fraîche exit 0 ; run réel du banc rc=0 avec workspace sous TMPDIR et
zéro dossier créé dans le dépôt. Restent ouverts les douze constats à
décision humaine. SHA `ac7ad3e` reporté sur l'entrée précédente.

### (ce commit) — Mémo de décision des constats en attente

`docs/memo-decisions-audit.md`. Les treize constats de l'audit restés
ouverts (douze « décision humaine », un mécanique écarté), chacun avec
enjeu, recommandation argumentée et coût : sessions par lancement,
course KeepAlive, dépendance au clone, sens de `context_length`,
étiquette et précédence du prompt, opt-out du noyau, protocole du banc
(HOME, métrique clé), `DATA_DIR`. z02-004 y est clos de fait par le
passage sous TMPDIR. SHA `a733bba` reporté sur l'entrée précédente.

## Hors dépôt (machine locale)

- Fork créé : `Alexmacapple/smolcoder-MTPLX`.
- Déclaration du host MTPLX dans `~/.smolcoder.json`.
- Noyau global installé : `~/.smolcoder/AGENTS.md` (1 908 caractères,
  copie conforme de `docs/agents-md-global.md`).
- LaunchAgent `com.alex.smolcoder-web` pour `smol --web` (démon,
  log `~/.smolcoder-web.log`, port 7433, clé imprimée au démarrage).
- Lanceur `launch-smol-mtplx.command` dans `~/Claude/lanceurs/`,
  copié à la racine du fork depuis `659f266` (interface web par
  défaut, `--session`, `--test`).
