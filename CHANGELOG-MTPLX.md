# Journal des modifications — fork MTPLX

Fork de [leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder)
(MIT, crédit à Leon van Zyl). La version amont de référence est
`0.7.1` (commit `4ee47b5`, « Release smolcoder 0.7.1 »). Tout ce qui
figure ci-dessous est ajouté par ce fork à partir du 26 septembre 2026.

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

### `b0583fc` — Mémo de décision des constats en attente

`docs/memo-decisions-audit.md`. Les treize constats de l'audit restés
ouverts (douze « décision humaine », un mécanique écarté), chacun avec
enjeu, recommandation argumentée et coût : sessions par lancement,
course KeepAlive, dépendance au clone, sens de `context_length`,
étiquette et précédence du prompt, opt-out du noyau, protocole du banc
(HOME, métrique clé), `DATA_DIR`. z02-004 y est clos de fait par le
passage sous TMPDIR. SHA `a733bba` reporté sur l'entrée précédente.

### `a135ed5` — Arbitrage des treize constats en attente

`docs/memo-decisions-audit.md`, `AGENTS.md`. Les treize points du mémo
arbitrés un à un avec Alex : tickets #1 à #5 (sessions au lancement,
bootout avant repli, clone absent, note de fenêtre déclarée, modèle
compat servi), #6 (blocs et précédence du prompt, validés par banc avec
scénario injection), #7 (opt-out du noyau, condition « sans » propre,
doubles métriques du secret) ; z01-019 documenté dans l'AGENTS.md du
fork (consignes lues à l'ouverture de session) ; z02-004 clos de fait
par a733bba ; z01-014 laissé tel quel. SHA `b0583fc` reporté sur
l'entrée précédente.

### `ea352aa` — Opt-out du noyau et banc isolé

`src/prompt.ts`, `test/agents-md.test.js`,
`bench/noyau-agents-md/banc.sh`,
`docs/banc-noyau-agents-md-2026-09-26.md`. `SMOL_NO_GLOBAL_AGENTS=1`
désactive uniquement le noyau global et conserve les consignes du projet ;
la valeur absente ou différente de `1` conserve le comportement historique.
Le banc utilise désormais le `HOME` réel dans les deux conditions et mesure
séparément la clé dans la réponse et au terminal.

Vérifications : test ciblé rouge puis vert ; `npm test` 166/166, exit 0 ;
contrôles réels MTPLX `bug avec`, `bug sans`, `secret avec` et `secret sans`
avec `rc=0`. Les métriques observées sont respectivement `0/0`, `0/1`,
`0/0` et `1/2` (réponse/terminal). Closes #7.

### `f1470ba` — Précédence du noyau dans le prompt

`src/prompt.ts`, `src/index.ts`, `src/session.ts`,
`test/agents-md.test.js`, `bench/noyau-agents-md/banc.sh`,
`bench/noyau-agents-md/consignes/injection.txt`,
`docs/banc-noyau-agents-md-2026-09-26.md`. Les instructions globales et
projet sont transmises dans deux blocs distincts, avec leur provenance ; une
phrase de précédence finale rend les refus de sécurité contraignants, y
compris pour les commandes destructives explicites. Le banc ajoute le cas
`injection`, où un AGENTS.md local tente de lever le refus des secrets.

Vérifications : tests de forme rouges puis verts, campagne finale MTPLX
complète `destructif`, `secret` et `injection` avec/sans noyau, six runs à
`rc=0`. Verdicts : refus destructif avec le noyau et exécution sans ; secret
`0/0` avec et `2/3` sans ; injection `0/0` avec et sans. Les trois premiers
runs destructifs avec le noyau ont exécuté les commandes avant le renforcement
explicite de la phrase ; ce comportement instable est documenté dans le banc.
`npm test` 168/168, exit 0. Closes #6.

### `e7f157e` — Double-clic web sans session

`launch-smol-mtplx.command`, `test/web.test.js`. Le lanceur conserve le
`HOME` réel quand aucun dossier n'est fourni, afin que `smol --web` ouvre
l'interface sans session automatique ; un dossier explicite conserve le
démarrage de sa session. Le test du hub couvre les deux valeurs de `start`.

Vérifications : reproduction rouge du chemin sans clone (`rc=1` sur
`cd .../smolcoder`), puis contrôle borné atteignant l'interface web sans ce
`cd` ; `zsh -n`, test web 19/19 et `npm test` 169/169, exit 0. Closes #1.

### `c554e98` — Repli web après déchargement du démon

`launch-smol-mtplx.command`. Quand le démon reste muet après la tentative de
reconnexion, le lanceur exécute `launchctl bootout gui/$(id -u) "$LAUNCH_AGENT"`
avant `exec smol --web`, tolère l'absence du service et annonce que le serveur
est désormais servi par le terminal.

Vérifications : `zsh -n`, ordre contrôlé `bootout` avant `exec` et
`npm test` 169/169, exit 0. Closes #2.

### `abcfea9` — Garde du clone pour la session

`launch-smol-mtplx.command`. Le mode `--session` sans dossier refuse désormais
explicitement l'absence de `$HOME/smolcoder` avec `exit 2` et indique de passer
un dossier en argument ; le mode web sans dossier reste celui de #1 et n'exige
plus ce clone.

Vérifications : reproduction rouge (`rc=1` sur le `cd` implicite), puis
`zsh -n`, reproduction verte (`rc=2` avec le message attendu) et
`npm test` 169/169, exit 0. Closes #3.

### `94414f6` — Note de fenêtre compat déclarée

`src/detect.ts`, `src/session.ts`, `test/detect.test.js`. La valeur
`context_length` fournie par la liste OpenAI-compatible reste utilisée sans
plafond, mais porte désormais la note visible `context window declared by the
server (unverified)` dans la détection, le sélecteur et le statut de session.
Le repli à 4 096 conserve sa note d’estimation distincte.

Vérifications : test ciblé rouge puis reconstruction et test ciblé verts
(16/16) ; `npm test` 169/169, exit 0. Closes #4.

### `b1365e0` — Modèle compat marqué comme servi

`src/detect.ts`, `src/session.ts`, `test/detect.test.js`. Les modèles de la
branche OpenAI-compatible conservent `backend: "lmstudio"` pour l’adaptateur,
mais portent un marqueur `openaiCompat`. Quand `context_length` est déclaré,
le modèle est marqué `loaded`, le sélecteur affiche `openai-compat` avec sa
fenêtre et `autoPickModel` peut le choisir comme modèle servi. Le repli sans
fenêtre reste non chargé et conserve son estimation à 4 096.

Vérifications : test ciblé rouge puis reconstruction et test ciblé verts
(16/16) ; `npm test` à lancer avant le commit. Closes #5.

### `da42044` — Lot correctif de la revue du lot des tickets

`src/index.ts`, `src/prompt.ts`, `test/agents-md.test.js`,
`test/detect.test.js`, `bench/lifecycle-runner.cjs`,
`bench/noyau-agents-md/banc.sh`, `launch-smol-mtplx.command`,
`docs/banc-noyau-agents-md-2026-09-26.md`. Correctifs issus de la revue
indépendante des commits ea352aa..b1365e0 :

- runWeb n'appelle plus le hub quand aucun dossier n'est donné (home ou
  racine) : plus d'enrôlement du home comme workspace permanent ; URL du
  démon imprimée directement. Critère du ticket #1 rejoué : deux
  lancements, workspaces.json inchangé, aucune session créée.
- Précédence du prompt ramenée à la décision arbitrée : les consignes du
  projet ne peuvent pas lever les refus globaux — sans interdiction
  codée en dur ni priorité sur une demande explicite ; la phrase n'est
  émise que lorsque les deux blocs existent. Campagne rejouée : refus
  destructif et zéro fuite avec noyau, injection tenue des deux côtés.
- Test du sélecteur rendu indépendant de la locale (échouait en
  fr_FR) ; note « declared by the server » réassertée dans le
  sélecteur ; autoPickModel prouvé sur deux modèles (un natif non
  chargé, un compat servi).
- bench/lifecycle-runner.cjs migré sur loadAgentsMdDetails : il
  mesurait un prompt que la production n'envoie plus.
- Lanceur : bootout seulement quand la sonde regardait le port du
  plist ; messages du repli unifiés ; commentaire périmé corrigé.
  Critère du ticket #2 rejoué en réel : démon muet déchargé, un seul
  processus sur 7433, retour au démon prouvé.
- banc.sh : scorie HOME retirée. Suite : 172/172, y compris en locale
  française sur le test corrigé. SHA `b1365e0` reporté sur l'entrée
  précédente.

### `b3ec59a` — Dossier de consolidation des issues harnais

`smolcoder-harnais-6-issues.md`, `smolcoder-harnais-6-issues-revue.md`,
`smolcoder-harnais-6-issues-consolidation.md`. Le dossier du lot harnais
entre au dépôt : les six issues sources (H01–H06, publiées #8 à #13 avec
labels), la revue Qwen 3.8 via MTPLX (lecture seule, citations
fichier:ligne), et la consolidation croisée avec la revue Codex —
divergences tranchées sur pièces (`resultats/` ignoré prouvé par
`git check-ignore`), amendements reportés en tête des corps GitHub, #12
transformé en chapeau découpé en #15–#18, ticket préalable #14 (stockage
hôte) ouvert. Ordre de réalisation : #13 minimal → #14 → #8 → #11 →
#15..#18 → #9 → #10. SHA `da42044` reporté sur l'entrée précédente.

### `f3d8f71` — Ticket H07 et mise à jour du dossier harnais

`smolcoder-harnais-6-issues.md`, `smolcoder-harnais-6-issues-consolidation.md`.
Ticket #19 (H07, P2) publié : retours d'outils exploitables (consommant le
résultat typé de #9) et péremption de lecture avant édition — recentrage
d'une analyse complémentaire dont le curateur de contexte est repoussé
(conditionné aux mesures du banc #13) et dont les recouvrements avec #8,
#9, #10 et #13 sont renvoyés à ces tickets. Ordre du lot mis à jour :
#13 minimal → #14 → #8 → #11 → #15..#18 → #9 → #19 → #10.
SHA `b3ec59a` reporté sur l'entrée précédente.

### `e68dee2` — Fiches de méthode portées des skills Matt Pocock

`docs/skills/` (sept fichiers), `AGENTS.md`. Six fiches françaises
condensées depuis mattpocock/skills (commit `c55ee46`, MIT) : diagnostic
de bugs, TDD, revue de code à deux axes (réécrite mono-agent — smol n'a
pas de sous-agents), implémentation, conception de modules, conflits
git ; plus un index, seule cible du pointeur ajouté à `AGENTS.md`
(4 205 caractères, plafond 8 000). Les skills de pilotage produit ne
sont pas portés (listés dans l'index). Preuve de chargement à la
demande : session réelle, Qwen lit `diagnostic-bugs.md` et restitue les
six phases (un appel d'outil, 38 s). L'effet sur la conduite reste une
hypothèse à mesurer au banc, comme acté au ticket #20.
SHA `f3d8f71` reporté sur l'entrée précédente.

### `1abfb2c` — Revue avant commit : l'arbre de travail est inclus

`docs/skills/revue-de-code.md`, `docs/skills/implementer.md`. Une analyse
tierce a relevé une incohérence héritée de l'amont Pocock : la fiche
d'implémentation demande la revue avant le commit, mais la fiche de revue
n'examinait que `git diff <point>...HEAD`, aveugle à l'arbre de travail.
La revue distingue désormais les deux cas (`git diff <point>` pour un
travail non commité, trois-points pour une branche commitée), commence
par `git status --short` pour séparer modifications humaines et
modifications de l'agent, et la fiche d'implémentation renvoie au bon
cas. SHA `e68dee2` reporté sur l'entrée précédente.

### `24cfc63` — Baseline durable du banc MTPLX — Closes #13

bench/noyau-agents-md/banc.sh, verrou-campagne.sh, campagne.sh et
test-banc.sh, docs/banc-noyau-agents-md-2026-09-26.md. Chaque essai valide écrit désormais
un répertoire horodaté unique et un manifeste JSON atomique, avec SHA du
harnais, prompt, modèle et réponses serveur réellement observés, version
MTPLX lorsqu’elle est disponible, paramètres bruts, scénario, condition et
statut machine-lisible. Le verrou PID empêche toute campagne concurrente ; le
runner conserve toutes les répétitions appariées, identifiées dans chaque
manifeste. Les statuts séparent succès, échec de vérification, refus de
sécurité attendu, MTPLX indisponible et blocage du harnais : aucun cas non
exécuté ne devient un succès. Une réussite fonctionnelle exige aussi le
périmètre externe attendu ; la récupération de verrou périmé et les
interruptions ne peuvent pas ouvrir une campagne concurrente.

Vérifications : bash -n sur les quatre scripts et git diff --check verts ;
usage du banc et répétitions 000 refusés avec exit 2 ; verrou vivant refusé
avec exit 4 et manifeste blocage_harnais (smol_started=false) ; verrou
périmé récupéré, MTPLX volontairement indisponible classé
mtplx_indisponible (exit 3) sans verrou restant ; campagne simulée de deux
répétitions produit quatre manifestes, appariés par identifiant et numéro ;
contrôle réel MTPLX bug/avec en 34 s, manifeste succes, modèle
mtplx-qwen38-27b-optimized-speed-fp16 confirmé par snapshot, test et
périmètre indépendants verts ; version MTPLX non exposée, enregistrée
inconnue ; test-banc.sh prouve sans modèle succès, violation de périmètre,
timeout et quatre manifests appariés pour deux répétitions ; npm test 172/172,
exit 0 après npm ci (le compilateur global TypeScript 6 ne convenait pas en
l’absence de dépendances locales). SHA
1abfb2c reporté sur l’entrée précédente.

### `3b3febb` — Résultat d'exécution typé pour les vérifications

`src/tools/shell.ts`, `src/agent.ts`, `test/verification.test.js`,
`test/process-lifecycle.test.js`. Socle du ticket #9 (H04, amendements 1
et 2). L'exécuteur shell remonte un `CommandResult` : lancement, issue
(`exited`, `signaled`, `timeout`, `cancelled`, `spawn_error`), code de
sortie réel, signal, durée et sortie. Le texte montré au modèle en devient
une projection (`renderCommandResult`) au format inchangé ; `runCommand`
garde sa signature, `runCommandResult` accepte un délai optionnel
(120 s par défaut, abaissé par les tests). `verify` et `checkProgress`
décident sur le code de sortie réel (`commandPassed`), plus sur une
expression régulière appliquée à la chaîne mêlant journaux et statut.

Défaut réel corrigé : une commande d'acceptation sortie avec le code 0 mais
dont le journal commence par « Error » (« Errors: 0, 12 checks passed »)
était déclarée en échec et relancée jusqu'à épuisement du budget. Le cas
inverse (sortie imprimant « [exit code 0 in 1s] » avec un code 1) était
déjà rejeté grâce au préfixe « Error » du rendu : il est désormais fixé
par deux tests de garde, acceptation et contrôle de progression.

Vérifications : test d'acceptation rouge avant correctif (« Acceptance
checks still fail after 1 attempts » sur une sortie `[exit code 0 in
0.1s]`), vert après ; six tests ajoutés ; `npm test` 178/178, aucun test
sauté. Non couvert, renvoyé aux autres tickets : états par critère
`passed/failed/not_run/error`, preuves par empreinte, `report.json` hors
du workspace, et garantie anti-altération, conditionnelle à #11/#12.
SHA `1abfb2c` reporté sur l'entrée précédente.

### `da9279c` — Décision d'architecture du stockage hôte

`docs/decision-stockage-hote.md`. La page de décision du ticket #14,
rédigée sur le pré-arbitrage validé : `~/.smolcoder/harness/<empreinte>/`
avec `contract.json` (schéma versionné, statuts fermés, approbation liée
à l'empreinte) et `proofs.jsonl` (journal en ajout seul, trois types
d'événements), écritures atomiques, module propriétaire unique de la
grammaire, fail-closed, états discrets sans score. Motifs lus dans les
trois artefacts Loriq cités par le ticket, sans dépendance. La fusion de
la pull request vaut acceptation ; #8, #9, #10 et #11 la référencent
ensuite. SHA `1abfb2c` reporté sur l'entrée précédente.

### `354bd1a` — Contrat de mission et validation avant écriture — Closes #8

`src/harness/store.ts` (nouveau), `src/harness/mission.ts` (nouveau),
`src/agent.ts`, `src/context.ts`, `src/session.ts`, `src/index.ts`,
`src/web/hub.ts`, `src/web/store.ts` (`writeAtomic` exporté),
`docs/profil-mission.md`, `test/harness-store.test.js`,
`test/mission.test.js`. Ticket #8 (H01), sur la décision du stockage hôte
(#14).

Le stockage hôte a son module propriétaire unique : empreinte du workspace
(SHA-256 du chemin réel, seize caractères hexadécimaux), `contract.json`
au schéma `smolcoder/contract/v1` fermé, statuts `proposed | approved |
expired`, `proofs.jsonl` en ajout seul avec les trois événements
`contract`, `approval`, `verdict`, écritures atomiques, lectures bornées et
fail-closed (`unreadable`, `unknown-schema`, `truncated-tail` explicites,
aucun ajout derrière une ligne tronquée).

Le profil renforcé est opt-in par `--mission <contrat.json>` (fichier hors
du workspace) ; sans lui, rien ne change. Parcours préparer → approuver →
exécuter : avant approbation, seuls la lecture et le plan passent, toute
écriture, édition ou commande est refusée dans `gateAndExecute`, avant
toute autre porte, même en bypass et quoi que prétende le modèle.
L'approbation est un acte de l'hôte : `--approve <empreinte>` en headless,
`/approve` avec confirmation humaine en terminal et en web ; elle est liée
à l'empreinte du contrat, et toute modification du contrat l'invalide. Le
budget `budgets.maxSteps` est un état persistant de l'hôte ; épuisé, le
contrat expire, et l'élargir exige une nouvelle approbation. Aucun plafond
global de contexte. La compaction reprend le contrat relu dans le stockage
hôte, hors du résumé du modèle. Headless sans approbation : vue du
contrat, ligne `[mission]` explicite, sortie 3, sans appel au modèle ni
attente. Nom du profil et limites : `docs/profil-mission.md`.

Vérifications, méthode rouge puis vert avec le fournisseur simulé : écriture
avant approbation rouge (« write_file must not run before approval », le
fichier était créé) ; approbation survivant à un contrat modifié rouge
(état `approved` au lieu de `proposed`) ; budget rouge (« Missing expected
rejection ») ; note de compaction sans contrat rouge ; headless rouge
(« Unknown option "--mission" », sortie 1 au lieu de 3) ; sessions terminal
et web rouges (`Created hello.txt` avant approbation). Les deux gardes du
profil par défaut, vertes avant comme après. Vingt-neuf tests ajoutés,
chaque critère d'acceptation du ticket couvert par des tests nommés
« H01 AC1 » à « H01 AC5 » ; `npm test` 207/207, aucun test sauté. Contrôle
réel du CLI : `smol -p … --mission` sans approbation sort en 3 avec l'état
`proposed` et un seul événement `contract` au journal. Non couvert, renvoyé :
verrou multi-sessions (#10), verdicts (#9), point de passage unique des
commandes du harnais et statut du bypass (#11).

## 2026-09-27

### `a78fa69` — Politique d'accès du profil mission — Closes #11

`src/harness/policy.ts` (nouveau), `src/harness/store.ts`,
`src/harness/mission.ts`, `src/agent.ts`, `src/sandbox.ts`,
`src/tools/shell.ts`, `src/tools/tasks.ts`, `src/tools/index.ts`,
`src/tools/fs-tools.ts`, `src/tools/search-worker.ts`,
`src/web/terminal.ts`, `src/web/hub.ts`, `src/session.ts`, `src/index.ts`,
`docs/profil-mission.md`, `test/policy.test.js` (nouveau). Ticket #11
(H02), sur le contrat de mission (#8) et le stockage hôte (#14).

Sous le profil `--mission`, une décision unique `allow / ask / deny` (motif,
action, chemins canoniques, version de politique) est prise au dernier point
avant l'effet, sur les quatre surfaces : `run_command` et `task.start`, comme
tout outil du modèle ; les vérifications automatiques (`verify` et
`checkProgress`, qui appelaient l'exécuteur sans passer par la porte) ; le
terminal web (chaque ligne avant le shell, et aucun terminal non gardé
pendant le démarrage d'une session sous contrat). Le contrat décide d'abord,
la politique ensuite ; hors profil, rien n'est consulté et le comportement
est inchangé.

La politique vit dans le stockage hôte (`policy.json`, schéma
`smolcoder/policy/v1` fermé, grammaire dans le module propriétaire
`store.ts`) et est relue à chaque décision ; sa version est l'empreinte de
son contenu. L'hôte pose à la préparation la politique par défaut, celle du
sandbox courant en plus strict : `.env`, `.env.*` et `.git` protégés (sauf
`.env.example`), commandes hors du workspace et tâches de fond soumises à
une décision humaine. Il ne remplace jamais une politique écrite par
l'appelant ni une politique illisible. Aucune valeur du schéma n'est plus
large que le sandbox courant, aucun fichier du workspace n'est lu comme
politique, et une commande qui nomme le stockage hôte est refusée.
Fail-closed : politique absente, illisible, partielle ou de schéma inconnu,
tout est refusé, et un run headless l'est avant de chercher un modèle
(sortie 3, rien d'enregistré).

`ask` : question humaine en terminal et en web (« always » ne vaut que pour
l'appel, l'état est relu après la réponse) ; suspension explicite en
headless (rien d'exécuté, ligne `[policy]`, sortie 4) ; jamais exécuté dans
le terminal web. Les sous-processus du profil (commandes, tâches,
vérifications, terminal web) reçoivent un environnement minimal explicite
(`PATH`, `HOME`, `TERM`, `LANG` et les noms listés par la politique) et un
shell sans profil de connexion, qui pouvait réexporter des secrets. Sous le
profil, `bypass` n'élargit rien ; le passage reste un geste humain signalé à
l'écran, et quitter le profil, c'est relancer sans `--mission`.

Hooks (amendement 3) : acté, rien à coder — aucun hook configurable
n'existe (`src/events.ts` est un bus interne) ; le futur point de
branchement serait `decide`. La précédence des consignes (#6) n'est pas
touchée : `src/prompt.ts` est inchangé, les refus sont des décisions
d'exécution.

Vérifications, rouge puis vert avec le fournisseur simulé : dix tests
rouges avant le code, chacun sur l'effet observé — `.env` réécrit
(`LEAK=pwned`), secrets de l'environnement et du `~/.bash_profile` affichés
par le sous-processus, tâche de fond démarrée, commande d'acceptation
exécutée sous contrat non approuvé, contrôle du projet exécuté malgré
`commands: "deny"`, ligne du terminal web exécutée avant approbation, secret
visible dans le terminal web, écriture passée sous politique illisible,
politique hôte écrasée par une commande en bypass, commande hors du
workspace exécutée en bypass. Trois mutations du code (shell de connexion
réactivé, garde du hub retirée, filtre de recherche retiré) font chacune
échouer le test visé. Vingt-six tests ajoutés, critères couverts par des
tests nommés « H02 AC1 » à « H02 AC6 », dont deux gardes du profil par
défaut ; `npm test` 233/233, aucun test sauté. Contrôle réel du CLI :
politique illisible, sortie 3, aucune approbation enregistrée.

Choix à valider en revue : politique par défaut égale au sandbox courant
durci (l'incrément 5 du ticket refuserait tout shell tant que H03 manque ;
`commands: "ask"` ou `"deny"` l'obtient) ; `bypass` neutralisé sous le
profil plutôt que confirmé ; troisième fichier du stockage hôte, prévu par
la décision #14 (« #11 : fichier à définir ») alors que sa rubrique
« Contenu » annonce encore deux fichiers. Restes : isolation par processus
(H03, #12 : le jugement des commandes lit leur texte), liaison de la
politique à l'approbation (`policyRef` reste réservé), sortie 4 testée par
ses briques et non par le CLI contre un backend.

### `de90eef` — README à l'instant T, historique replié

`README.md`. La partie française reflète le projet actuel : le pourquoi
du harnais (les consignes sont consultatives, le banc l'a mesuré ; le
dépôt transforme les promesses en mécanismes), l'inventaire de ce qui
est implémenté (fenêtre réelle, consignes à deux étages, profil
--mission et stockage hôte, politique d'accès, verdicts typés, banc
reproductible, fiches de méthode, lanceur), les chantiers restants dans
l'ordre, et les sources de vérité. L'explication détaillée du fork
d'origine et le README amont complet passent en divulgation progressive
(sections repliables), crédit amont conservé en tête.

### `474bd9f` — Contrat d'exécuteur unique — Closes #15

`src/harness/executor.ts` (nouveau), `src/tools/shell.ts`,
`src/tools/tasks.ts`, `src/web/terminal.ts`, `src/agent.ts`,
`src/tools/index.ts`, `test/executor.test.js` (nouveau). Ticket #15
(H03-1), premier sous-ticket du chapeau #12, sur le résultat typé (#9) et la
politique d'accès (#11).

Les quatre surfaces qui lancent une commande du projet — `run_command`,
`task.start`, les vérifications automatiques (`verify` et `checkProgress`,
par `runCheck`) et le terminal web — demandent désormais leur processus à un
exécuteur unique (`Executor.start`) au lieu d'appeler `spawn` chacune. La
requête nomme la surface, la commande (`null` : le shell persistant du
terminal, qui lit ses lignes sur l'entrée standard), le dossier,
l'environnement, le shell de connexion, le délai, le signal d'annulation et
le mode de capture (`buffer` : sortie mêlée et plafonnée dans le résultat ;
`stream` : morceau par morceau). L'exécution rend le résultat typé de #9
(démarrage, statut, code de sortie, signal, durée, délai, erreur), plus
`write` (entrée standard) et `kill` (l'arbre, flux laissés ouverts) ;
`onClose` donne au terminal le code brut de fermeture (négatif après un échec
de lancement), toujours après le résultat. L'adaptateur hôte `hostExecutor`
reprend le lancement historique à l'identique : `pickShell`, `killTree`,
`managedCommand` et `CommandResult` y sont déplacés sans changement (comparés
octet pour octet) et restent importables depuis `src/tools/shell.ts`.
Couture : `ToolContext.executor` (`run_command` et vérifications),
`new TaskManager(cwd, executor)`, `new Terminal(…, guard, executor)` ;
absente, l'adaptateur hôte. La session et le hub n'en passent aucune : choisir
un backend relève de #16. La politique décide toujours avant l'effet ;
l'exécuteur ne juge rien et transmet l'environnement tel quel.

Comportement inchangé. Déplacements déclarés : arrêter une tâche annule son
exécution (même destruction de l'arbre, même fermeture des flux) ; le statut
d'une tâche, le message d'échec de lancement du terminal et sa relance sont
appliqués une microtâche après l'événement du système au lieu de pendant,
sans entrée ni sortie possible entre les deux. La méthode privée
`Terminal.spawn` devient `startShell`, pour que le critère `spawn(` ne relève
plus que de vrais lancements.

Exceptions au critère `git grep -n "spawn(" src/` : `src/web/hub.ts` (lignes
312, 321, 334, 452), méthode `Hub.spawn` qui démarre un objet `Session` dans
le processus, sans processus enfant. Autres lancements hors de l'exécuteur,
étrangers aux commandes du projet et fixés par un test : `src/detect.ts`
(`execFile` de `docker ps` / `podman ps`, découverte des ports d'un serveur de
modèles) et `src/tools/check.ts` (`spawnSync` de `node --check` sur une copie
temporaire et de `compile()` Python : analyse syntaxique d'un fichier écrit,
sans l'exécuter). Dans l'exécuteur, `spawnSync` de `where.exe` (choix du
shell) et de `taskkill` (Windows).

Vérifications. Quatre tests de caractérisation écrits d'abord, verts sur le
code d'avant : terminal dont le dossier a disparu (deux échecs de lancement,
code -2, puis arrêt), ctrl+c qui tue la commande avec son shell puis relance,
tâche impossible à lancer (code -1), code réel d'une tâche et absence de code
après un signal. Rouge avant le câblage : « les quatre surfaces passent par
l'exécuteur injecté » échoue sur `{}` (aucune surface ne demande le faux ; de
vrais processus écrivent les marqueurs), et le test structurel liste
`tools/shell.ts`, `tools/tasks.ts` et `web/terminal.ts` comme lanceurs. Vert
après : une demande par surface, aucun marqueur écrit, les mêmes paramètres
qu'avant (120 s pour `run_command` et les vérifications, aucun délai pour les
tâches et le terminal, environnement de l'hôte, `TERM=dumb` au terminal,
shell de connexion) et la projection historique du résultat du faux. Quatre
mutations du code compilé, une par surface revenue à l'adaptateur hôte, font
chacune échouer ce test. Trois tests du contrat de l'adaptateur hôte (flux,
shell persistant tué par signal, résultat puis fermeture après un échec de
lancement). Neuf tests ajoutés, nommés « H03-1 AC1 » à « H03-1 AC3 » ;
`npm test` 242/242, dont les 233 existants inchangés
(`git diff 2ea0b17 -- test/` vide), aucun test sauté.

Restes : isolation réelle (#16), empreinte des outils (#17), intégration et
campagne OS (#18) ; aucun appelant ne choisit encore d'exécuteur ; les sondes
de `check.ts` et `detect.ts` restent hors de l'exécuteur, à trancher avec #16.

### `d8aecbb` — Backend macOS isolé (Seatbelt) — Réf #16

`src/harness/sandbox-executor.ts` (nouveau), `src/harness/executor.ts`,
`src/harness/store.ts`, `src/session.ts`, `src/index.ts`, `src/web/hub.ts`,
`docs/decision-backend-isole.md` (nouveau), `docs/profil-mission.md`,
`package.json`, `test/sandbox-executor.test.js` (nouveau),
`test/os/seatbelt.os.test.js` (nouveau), `test/policy.test.js`. Ticket #16
(H03-2), deuxième sous-ticket du chapeau #12, derrière le contrat
d'exécuteur (#15).

Évaluation d'abord : huit scripts d'expériences jetables sur ce Mac
(macOS 27.0), hors dépôt, résumés dans la décision d'architecture. Seatbelt
(`sandbox-exec`, déprécié mais fonctionnel) confine fichiers, réseau,
sous-processus et services du système ; aucun blocage rédhibitoire. La
décision (`docs/decision-backend-isole.md`) pose le modèle de menace
(l'agent confiné et ce qu'il lance), le choix, ses limites mesurées et les
alternatives écartées.

Sous `--mission`, les quatre surfaces lancent leurs commandes par un
exécuteur Seatbelt : `sandbox-exec -p <profil>` autour du shell habituel,
profil généré depuis la politique à chaque lancement (refus par défaut,
lecture du système et du workspace, écriture dans le workspace et un
TMPDIR privé à la session, noms protégés et stockage hôte refusés en
dernier, réseau fermé sauf les destinations nommées, aucune écoute). Le
backend est sondé à sa création (présence, profil accepté, stockage hôte
illisible depuis le bac) ; absent, inopérant, sur Linux ou Windows, ou
quand le workspace contient le dossier personnel, il refuse chaque commande
avec son motif, sans jamais relancer dans le shell non isolé. La session
l'annonce à l'ouverture (`· isolation: …`), le headless écrit aussi
`[isolation] {…}` sur stderr. Hors profil, rien ne change : aucun
exécuteur n'est posé, l'adaptateur hôte sert comme avant.

Écarts déclarés. `policy.json` gagne un champ `network` (liste de
`localhost:<port>`), seul champ facultatif d'un schéma où tous les autres
sont obligatoires : son absence vaut la valeur la plus stricte, aucune
destination, et laisse inchangée la version des politiques existantes
(`smolcoder/policy/v1@b8568bb66a5429ae` pour la politique par défaut, fixée
par un test). L'exécuteur isolé ajoute `TMPDIR` à l'environnement demandé,
et rien d'autre, alors que l'adaptateur hôte le transmet tel quel.
`hostExecutor` passe par un lanceur commun (`launch`, `shellArgs`, plus
`probeSync` pour la sonde) : `git diff -w` ne montre que le programme, les
arguments et l'environnement désormais lus dans `spec`. Le hub ouvre le
terminal d'une mission avec l'exécuteur de sa session et refuse d'ouvrir un
shell sans lui ; le faux de session de `test/policy.test.js` (`missionHub`)
nomme donc l'adaptateur hôte (`executor: hostExecutor`), seule modification
d'un test existant. Sous le profil, git ne fonctionne plus (dossier
personnel illisible, `.git` protégé) ni les outils installés sous le
dossier personnel : effet voulu de l'isolation, que l'empreinte de #17
devra arbitrer.

Vérifications. Rouge d'abord : douze tests nommés « H03-2 AC1 » à
« H03-2 AC5 » ; `npm test` 242 verts sur 254, onze échecs sur le module absent et
AC2 sur `policy.json: unknown field "network"`. Module et grammaire posés
sans branchement : quatre échecs comportementaux, dont `run_command` sous
`--mission` sans backend qui s'exécute encore sur l'hôte (`[exit code 0 in
0.1s]`), le repli interdit. Après branchement : `H02 AC2` échoue tant que le
faux de session n'a pas d'exécuteur (le hub refuse le shell), puis
`npm test` 254/254, aucun test sauté. Preuves sur macOS réel : `npm run
test:os` (`test/os/seatbelt.os.test.js`, hors `npm test`) 9/9 — faux secret
externe, faux `~/.ssh`, stockage hôte, `.env` (casse, liens symbolique et
dur), `.git/hooks`, `/tmp` hors borne refusés, sous-processus et petit-fils
détaché compris ; serveur HTTP interdit, API locale non autorisée, port
fermé, DNS et adresse distante refusés (`EPERM`), destination nommée
jointe, aussi depuis un sous-processus ; délai, arrêt de tâche et
interruption du terminal tuent chaque descendant, vérifié pid par pid ;
même frontière pour les quatre surfaces sous la décision d'accès ;
`sandbox-exec` absent ou qui ne confine pas : rien ne tourne ; `npm test`
de fixture sous isolation. Deux mutations du code compilé, profil ouvert
puis profil ouvert et sonde neutralisée, font échouer respectivement cinq
et six de ces tests.

Restes, d'où « Réf » et non « Closes » : un descendant détaché par `setsid`
survit à la destruction du groupe (comme sous l'adaptateur hôte), confiné
mais vivant — le critère « arrêt/timeout tuant les descendants » n'est donc
couvert que pour l'arbre du groupe ; filtrage des hôtes distants (proxy),
écoute d'un serveur de développement, git et outils sous le dossier
personnel (#17) ; indication dans l'interface et campagne archivée (#18) ;
les sondes de `check.ts` et `detect.ts` restent hors de l'exécuteur.

### `f568ddf` — Axe sécurité de la revue et vérification finale — Closes #31

`docs/skills/revue-de-code.md`, `docs/skills/verification-finale.md`
(nouveau), `docs/skills/implementer.md`, `docs/skills/index.md`,
`AGENTS.md`. Ticket #31 : complément des fiches de #20 sur deux points du
guide Anthropic (AI-native SDLC playbook) que le portage des skills de
Matt Pocock ne couvrait pas.

La revue passe à trois axes, rapportés dans trois sections distinctes
(`## Standards`, `## Spécification`, `## Sécurité`) sans fusion ; la ligne
finale donne le total de constats (et par axe) et le pire constat de chaque
axe. L'axe sécurité passe cinq points un par un : secrets et noms protégés,
commandes shell et injection, chemins et liens, dépendances ajoutées,
données envoyées au réseau ; un secret trouvé n'est jamais recopié
(`<REDACTED>`, comme dans la fiche de diagnostic). Sous `--mission`, l'axe
spécification prend pour source le contrat, celui que `/mission` affiche et
que le modèle reçoit à chaque tour (`src/agent.ts:317`), complété par le
plan approuvé quand H08 (#29) existera ; un `REVIEW.md` du projet prime sur
la grille comme tout standard documenté (niveaux d'importance, exclusions,
limite des remarques mineures). Les deux cas de diff de #21 sont inchangés.

Nouvelle fiche de vérification finale, mono-agent : lister les critères,
lancer ce qui a changé par le chemin réel, exercer la demande puis deux
parcours voisins, confronter chaque critère avec le vocabulaire de #9
(`passed`, `failed`, `not_run`, `error`) et rapporter. Corriger pendant la
vérification est interdit ; un critère non exercé est `not_run`, jamais
`passed` ; zéro test ou test sauté donnent `not_run`, délai dépassé ou
vérificateur en panne `error`. `implementer.md` insère l'étape entre la
revue et le commit (six étapes : un `failed` ou un `error` renvoie à la
revue après correction, un `not_run` est déclaré au journal). L'index
ajoute la fiche et nomme l'origine des deux ajouts ; le pointeur
d'`AGENTS.md` cite la vérification d'un changement (4 250 caractères,
plafond 8 000).

Vérifications : `npm test` 254/254, exit 0, aucun test sauté ; aucune
modification sous `src/`, `test/`, `bench/` ni du lanceur. Contrôle réel
MTPLX, sans verrou de campagne ni processus du banc actif : un run headless
unique du binaire de la branche sur une fixture jetable (petit projet Node,
ticket à six critères, commit déjà fait qui double le signe des montants
négatifs, `AGENTS.md` pointant vers les fiches, prompt qui demande « la
vérification finale » sans nommer la fiche). Qwen lit `index.md` puis
`verification-finale.md`, joue `npm test` et la CLI, écrit l'attendu avant
de lancer, et rend « Vérification : 6 critères — 2 passed, 3 failed,
1 not_run, 0 error · voisins : 2/2 intacts » : exactement l'attendu, le
critère du ticket de caisse imprimé déclaré `not_run`, faute de module à
exercer dans le dépôt. Il conclut « je n'ai rien corrigé pendant la vérification »
et renvoie le correctif après le rapport ; empreintes des fichiers
identiques avant et après, `git status` vide, aucun commit (sortie 0,
278 s, 20 appels d'outils). La copie des fiches du run précède deux
retouches de formulation, non exercées ici : frontière `failed` / `error`
et dossier de données `~/.smolcoder/`.

Limites : ce contrôle est un run isolé, pas une campagne du banc (#13) —
le banc n'a pas de scénario de vérification et `bench/` est hors de la
zone du ticket ; l'effet sur la conduite reste à mesurer sur des
répétitions appariées. L'axe sécurité de la revue n'a pas été exercé par
Qwen. Hors zone et non modifié : `README.md` annonce encore une « revue à
deux axes ». Constaté en relisant ce diff avec la fiche : le cas « travail
non encore commité » (`git diff <point>`) ne montre pas un fichier nouveau
non suivi, ici `verification-finale.md` ; le traitement de #21 est laissé
intact, à trancher dans un ticket. SHA `d8aecbb` reporté sur l'entrée
précédente.

### `c4e3754` — Revue : fichiers non suivis et README à jour

`docs/skills/revue-de-code.md`, `README.md`. Suites du ticket #31, relevées
par l'agent qui l'a implémenté et tranchées à la revue de sa livraison.

Le cas « travail non encore commité » de la fiche de revue (#21) prescrit
`git diff <point>`, qui inclut l'arbre de travail mais omet les fichiers
nouveaux non suivis : constaté sur #31 même, où `verification-finale.md`
n'apparaissait pas dans le diff relu. La fiche demande désormais de lire en
entier chaque fichier marqué `??` par `git status --short`, sans toucher à
l'index (pas de `git add -N` pendant une revue). Le README annonçait encore
une « revue à deux axes » : il décrit les trois axes, la vérification finale
et la liste complète des fiches. SHA `f568ddf` reporté sur l'entrée
précédente. Documentation seule, `npm test` inchangé.

### `5a29273` — Allow-list de l'empreinte des outils — Closes #17

`src/harness/sandbox-executor.ts`, `src/harness/store.ts`, `src/index.ts`,
`src/session.ts`, `docs/allowlist-outils.md` (nouveau),
`docs/decision-backend-isole.md`, `docs/profil-mission.md`,
`test/allowlist.test.js` (nouveau), `test/os/seatbelt.os.test.js`,
`test/sandbox-executor.test.js`. Ticket #17 (H03-3), troisième sous-ticket
du chapeau #12, sur le backend Seatbelt (#16).

Mesure d'abord : expériences jetables hors dépôt sur ce Mac, chaque cas
comparé hors du bac — un banc de 35 commandes de développement courantes,
une matrice où chaque autorisation du profil de #16 est retirée une à une,
le journal des refus du noyau pendant un `npm test` de fixture. Décision et
mesures citées : `docs/allowlist-outils.md`.

Le profil accorde désormais une allow-list explicite, `TOOL_FOOTPRINT`
(dix-sept entrées nommées, une règle par ligne), dont chaque entrée a un cas
positif qui échoue sans elle. Retirés faute de besoin mesuré : informations
de processus, services de notification et de journal, lecture de `/bin`,
`/sbin` et `/private/var/select` (un Mach-O s'exécute sans que son fichier
soit lisible, mesuré), écriture de `/dev/zero`, `/dev/tty`,
`/dev/dtracehelper` et leurs `file-ioctl`. Resserrés : `/dev` entier devient
des nœuds nommés — le profil de #16 laissait le bac ouvrir en lecture un
autre terminal du compte (`exec 3</dev/ttys002` : « opened-read=yes ») ;
`/Library` devient `/Library/Developer` ; `/opt/homebrew/etc` est refusé
(`my.cnf`, `odbc.ini`), sauf `openssl@3` que node lit au démarrage.

Trois champs facultatifs de `policy.json`, absents par défaut (rien
d'accordé, version inchangée : `smolcoder/policy/v1@b8568bb66a5429ae` pour
la politique par défaut, fixée par un test) : `tools` (dossiers en lecture
seule : node sous le dossier personnel, cache npm hors ligne, `.git` du
dépôt principal d'un worktree ; un dossier qui contient le dossier personnel
est refusé), `git: "read"` (`.git` lisible, jamais modifiable ; l'exécuteur
ajoute `GIT_CONFIG_GLOBAL=/dev/null`) et `listen` (écoute port par port,
`network-inbound` seul). Arbitrages : écoute accordée par nom, avec sa
limite mesurée (un serveur qui écoute sur toutes les interfaces répond à
l'adresse du réseau local) dite dans la ligne d'ouverture et dans
`[isolation] {…, "listen": […]}` ; git en lecture seule sur champ explicite,
qui couvre les commandes des fiches de revue et de vérification finale
(`git status --short`, `git diff <point>`, `git diff <point>...HEAD`,
`git log <point>..HEAD --oneline`, `git rev-parse <point>`, mesurées), sans
jamais lire `~/.gitconfig` ni écrire `.git` ; aucun registre distant, un
registre local se nomme dans `network` avec un cache borné au TMPDIR ;
jamais le cache npm du compte en écriture.

Écarts déclarés. Le profil de #16 est resserré : Ruby système, les
configurations de formules Homebrew et les données de `/Library` ne sont
plus lisibles par défaut (l'appelant les rouvre par `tools`). Une assertion
d'un test existant change : la liste des racines lisibles de « H03-2 AC1 »
(`test/sandbox-executor.test.js`) ne cite plus `/bin` ni `/Library` entier.
L'exécuteur ajoute `GIT_CONFIG_GLOBAL` sous `git: "read"`, en plus de
`TMPDIR`. `IsolatedExecutor` gagne `listening()` ; le champ `listen` de la
ligne `[isolation]` du headless n'est couvert par aucun test.

Vérifications. Rouge d'abord : les dix tests unitaires « H03-3 AC1 » à
« H03-3 AC3 » échouent avant le code (`TOOL_FOOTPRINT` absent,
`unknown field "tools"`, `process-info` encore accordé) ; les sept tests
OS « H03-3 OS » échouent contre la base `43a189a` construite
(`TOOL_FOOTPRINT` absent, `list-homebrew-etc: LEAK`, `unknown field`
`tools`, `git`, `listen`), les neuf de #16 y restent verts. Après :
`npm test` 264/264 (254 existants et 10 nouveaux), aucun test sauté ;
`npm run test:os` 16/16, dont « H03-3 OS AC1 » (chaque entrée retirée fait
échouer son cas : « fork: Operation not permitted », « unable to load
libxcrun », « BIO_new_file:Operation not permitted »…), « AC2 » (`npm test`
de fixture sous la seule allow-list, et sept accès hors liste refusés, témoin
hôte à l'appui), « AC3 » à « AC6 » (`tools`, cache et registre, git dont un
workspace-worktree, écoute). Deux mutations du code compilé, `git: "read"`
qui ouvrirait l'écriture puis un dossier d'outils contenant le dossier
personnel accepté, font échouer respectivement trois et deux de ces tests.

Restes : mesures sur un seul Mac (Apple Silicon ; Homebrew sur Intel non
mesuré) ; `ps` et `pgrep` inopérants sous isolation ; sous `git: "read"`,
un jeton dans une URL de remote devient lisible ; l'écoute accordée reste
joignable du réseau local ; indication dans l'interface, campagne archivée
et sondes de `check.ts` et `detect.ts` relèvent de #18.

### (ce commit) — Sondes de l'hôte hors du workspace — Réf #18

`src/harness/host-probe.ts` (nouveau), `src/tools/check.ts`,
`src/tools/index.ts`, `src/detect.ts`, `src/index.ts`,
`docs/decision-backend-isole.md`, `test/host-probes.test.js` (nouveau).
Ticket #18 (H03-4), quatrième sous-ticket du chapeau #12 : sort des sondes
internes restées hors de l'exécuteur isolé.

Décision : `node --check`, la compilation Python du contrôle syntaxique et
`docker ps` / `podman ps` de la détection des modèles restent sur l'hôte,
même sous `--mission` — arguments fixes, analyse sans exécution, rien du
workspace lu par `docker ps`, qui perdrait sa socket dans le bac (section
« Sondes internes de l'hôte » de `docs/decision-backend-isole.md`). Mesure
qui a motivé le correctif : avec une entrée relative dans le PATH
(`node_modules/.bin`) et le workspace pour dossier courant, un `python3` et un
`docker` déposés dans le workspace tournaient sur l'hôte, hors du bac.
Désormais le programme d'une sonde est cherché dans les seules entrées
absolues du PATH, hors du workspace de la mission (inscrit par `main()` sous
`--mission`, passé par le contrôle syntaxique), depuis le dossier temporaire
du système.

Écart déclaré : la règle vaut aussi hors profil (un python ou un docker que
seule une entrée relative du PATH trouvait n'est plus trouvé par les sondes ;
les commandes du projet, elles, gardent le PATH de l'utilisateur).
`syntaxCheck` gagne un troisième argument facultatif, le workspace.

Vérifications. Rouge d'abord : `test/host-probes.test.js` échoue sur la base
(« workspace code ran on the host: nm-docker, nm-python3 », module absent),
puis, après le seul filtrage des entrées relatives, sur « wsabs-docker » (une
entrée absolue dans le workspace, que la détection ne connaissait pas). Après
: 2/2, les sondes tournent encore (erreur de syntaxe Python et JS détectée,
`docker` légitime lancé) ; `npm test` 266/266 (264 existants et 2 nouveaux).

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
