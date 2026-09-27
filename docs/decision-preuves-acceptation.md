# Décision d'architecture — verdicts et preuves d'acceptation protégées

Statut : rédigée le 2026-09-27 pour le ticket #9 (H04), sur le socle déjà
livré (résultat d'exécution typé, `3b3febb`), la politique d'accès (#11) et
l'isolation Seatbelt (#12, #15 à #18). La fusion de la pull request qui porte
cette page vaut acceptation ; s'en écarter ensuite exige une nouvelle
validation.

## Problème

Avant #9, sous `--mission`, « Qwen a répondu », « une commande a fini » et
« les critères du contrat sont vérifiés » se confondaient : un seul booléen
d'acceptation, aucun statut par critère, aucune trace datée, et le test de
référence exécuté par `npm test` restait un fichier du workspace que le modèle
pouvait réécrire (`"test": "exit 0"`, `.npmrc` avec `script-shell=./ok.sh`,
test affaibli). Un vert pouvait donc venir d'un récit, d'un test altéré ou
d'une preuve périmée.

## Définitions

### Statut d'un critère

Quatre valeurs, et seulement celles-là :

- `passed` : le contrôle qui couvre le critère a tourné par l'exécuteur isolé,
  il est sorti de lui-même avec le code 0, il a exécuté au moins un test s'il
  le dit, les entrées de son vérificateur sont celles que l'hôte a figées, et
  sa preuve vaut pour les fichiers actuels ;
- `failed` : le contrôle a tourné et il est sorti avec un code non nul ;
- `not_run` : le contrôle n'a pas tourné ou n'a rien testé — critère couvert
  par aucun contrôle de l'hôte (`not-covered`), contrôle sauté après un échec
  ou jamais atteint (`not-run`), zéro test exécuté (`zero-tests`), script npm
  absent ou vide (`missing-script`), refusé par la politique (`policy`),
  vérificateur modifié ou non figé (`verifier-changed`, `verifier-unfrozen`),
  preuve périmée (`stale`) ;
- `error` : le vérificateur lui-même a échoué avant de conclure — délai
  dépassé (`timeout`), arrêté par un signal (`crashed`, y compris un code
  128 + N rapporté par le shell pour ILL, TRAP, ABRT, EMT, FPE, KILL, BUS,
  SEGV, SYS ou TERM), lancement impossible (`spawn-error`, dont le backend
  isolé indisponible), aucun exécuteur isolé (`no-isolation`), entrées du
  vérificateur écrites pendant le contrôle, empreinte impossible, verdict non
  journalisé.

Aucune de ces situations ne donne `passed`. Le verdict vient de l'issue réelle
du processus (`CommandResult`) ; le texte de la sortie ne peut que retirer un
`passed` (zéro test), jamais en donner un : un journal qui imprime « exit code
0 » ou un faux résumé de tests ne change rien au code de sortie.

### Zéro test

Un contrôle qui sort 0 sans avoir exécuté de test ne prouve rien. Deux
constats, sans jamais lancer de code pour les faire :

- avant exécution, pour `npm test` et `npm run <nom>` : script absent ou vide
  (`--if-present` sortirait 0 sans rien lancer), ou script par défaut de
  `npm init` ;
- après exécution, les résumés reconnus des lanceurs courants — node:test
  (formats spec et TAP), Jest, Mocha, Vitest, pytest : aucun test exécuté,
  ou tous sautés. Sans résumé reconnu, le nombre de tests est « inconnu » et
  le rapport le dit.

### État de la tâche, décision humaine

L'état de la tâche est dérivé, dans cet ordre : `running` (tour en cours) ;
`cancelled` (annulé par l'utilisateur) ; `blocked` (contrat non approuvé,
décision humaine en suspens, contrôle refusé par la politique, entrées du
vérificateur modifiées ou non figées) ; `uncertain` (vérificateur en
`error`, preuve périmée, empreinte impossible, ou tous les critères passés
mais le tour arrêté sur une erreur) ; `incomplete` (au moins un critère
`failed` ou `not_run`) ; `verified` (tous les critères requis `passed` sur
les fichiers actuels).

La décision humaine d'accepter ou d'intégrer est un troisième axe, toujours
`pending` dans le rapport : le harnais ne l'enregistre jamais. Le plan du
modèle y figure comme déclaratif (« un plan coché n'est jamais une preuve ») ;
il n'entre dans aucun statut. Le plan d'implémentation approuvé avec le
contrat (#29, `docs/profil-mission.md`) non plus : sa preuve prévue par
critère est une déclaration, ses écarts une trace pour la revue ; le rapport
les montre dans une rubrique à part, après le bilan des critères.

### Critères requis et couverture

Les critères requis d'un tour sous `--mission` sont :

- chaque critère `acceptance` du contrat, couvert par un contrôle de l'hôte
  que le contrat déclare (`checks`, `docs/profil-mission.md`) ou `not_run
  (not-covered)` ;
- la commande `--verify` de l'appelant, si elle est donnée (fusionnée avec un
  contrôle identique du contrat) ;
- à défaut de contrôle de l'hôte, les contrôles découverts du projet après une
  écriture (`npm run build`, `npm run test`, `npm run test:e2e`), un critère
  et un verdict chacun. Ils ne couvrent jamais un critère du contrat : aucun
  test découvert ne vaut à lui seul acceptation du besoin.

Les contrôles tournent dans l'ordre, chacun séparément ; le premier qui n'est
pas `passed` arrête la tentative (les suivants restent `not_run`), ce qui
garde le budget d'essais et la réparation « première défaillance d'abord ».

### Identité du vérificateur et fichiers vérifiés

Les entrées du vérificateur sont ce qui décide du verdict sans être le code
soumis : `package.json` et `.npmrc` (à toute profondeur), la configuration des
lanceurs (Jest, Vitest, Vite, Playwright, Cypress, Karma, AVA, Babel, Mocha,
nyc, c8, `tsconfig*.json`, `pytest.ini`, `pyproject.toml`, `conftest.py`…),
les fichiers de test par convention (`*.test.*`, `*.spec.*`, `test_*.py`,
dossiers `test`, `tests`, `__tests__`, `spec`, `e2e`, `__snapshots__`,
`__mocks__`…), et les scripts que les commandes exécutent : script d'un
interpréteur, programme nommé par un chemin, outil de `node_modules/.bin`,
et, à travers `npm run <nom>` (avec `pre` et `post`), ceux des scripts de
`package.json`. Les sorties de build et dossiers temporaires (`dist`, `build`,
`coverage`, `tmp`…) n'en font jamais partie : les contrôles les régénèrent.

Leur identité est l'empreinte SHA-256 de la carte « chemin → empreinte du
contenu » (null pour un script nommé absent). Les fichiers vérifiés sont tout
le workspace hors `node_modules`, `.git` et noms protégés par la politique
(jamais lus), liens non suivis ; leur empreinte est prise quand la séquence de
contrôles d'une tentative se termine, et tous les verdicts de la tentative la
portent : un contrôle suivant qui écrit (les tests après le build) ne périme
pas le précédent.

Chaque verdict porte l'empreinte du contrat, celle des entrées figées et celle
des fichiers vérifiés. Une preuve est périmée dès qu'une des trois ne
correspond plus à l'état constaté : elle s'affiche alors `not_run (stale)`,
jamais `passed`.

## Décision : entrées du vérificateur figées à l'approbation

L'approbation de l'hôte (`--approve`, `/approve`) fige les entrées du
vérificateur telles qu'elles sont à cet instant, dans l'enregistrement
d'approbation de `contract.json` (hors du workspace). Avant approbation, le
modèle ne peut rien écrire : l'état figé est celui que l'hôte a préparé.
Ensuite, trois gardes, dont aucune ne repose sur la bonne foi du modèle :

1. Avant chaque tentative, les entrées actuelles sont comparées aux entrées
   figées : un fichier modifié ou retiré, un script nommé apparu, un fichier
   de test, de configuration, de mock ou d'instantané ajouté, et aucun
   contrôle ne tourne. Le verdict est `not_run (verifier-changed)`, le modèle
   reçoit la liste des fichiers changés, la tâche est `blocked`. Rétablir
   exactement le contenu figé suffit à relancer le vérificateur approuvé.
2. Pendant le contrôle, les tampons du noyau (inode, date de changement
   d'état) des entrées figées sont relevés avant et après : une écriture,
   même rétablie à l'identique, donne `error
   (verifier-changed-during-check)`. Un processus de fond ne peut ni
   échanger puis rétablir un test pendant le contrôle, ni remettre ces
   tampons en place.
3. À chaque génération du rapport, l'état du vérificateur est constaté à
   nouveau : des entrées modifiées bloquent la tâche quels que soient les
   verdicts au journal.

Toute modification légitime (un test corrigé par l'humain, un test écrit par
le modèle et relu) exige une nouvelle approbation humaine, qui nomme
l'empreinte exacte de ce qui sera figé : `--approve-verifiers <empreinte>` en
headless (l'empreinte figure dans la ligne `[mission]`, champ
`verifiers.current`), `/approve` en terminal et en web (les fichiers changés
sont affichés, puis une confirmation). Un événement `approval` au journal en
garde la trace. Repasser `--approve <contrat>` seul ne refige rien : un
appelant qui rejoue sa ligne de commande ne bénit pas en silence ce que le
modèle a changé.

Sous `--mission`, les contrôles décisifs passent par la décision d'accès (#11)
puis par l'exécuteur isolé de la session (#16) : sans lui, `error
(no-isolation)`, jamais de repli sur l'hôte. Le bac interdit au contrôle, comme
à toute commande, d'écrire dans le stockage hôte : le verdict et le rapport
restent hors de portée de l'agent qu'ils jugent (prouvé sur macOS réel,
`test/os/e2e.os.test.js`, test « H04 OS »).

## Alternatives écartées

- Exécuter le contrôle décisif depuis une copie de confiance (instantané des
  tests hors du workspace, superposé à une copie du code soumis) : coût d'une
  copie par tentative, `node_modules` à recopier ou à relier (et alors
  modifiable), chemins et environnement différents du projet réel ; et la
  copie devrait vivre dans un dossier que seul le contrôle peut écrire, ce que
  le contrat d'exécuteur (#15) ne sait pas accorder requête par requête. À
  reconsidérer si le banc montre des altérations que les gardes ci-dessus
  laissent passer.
- Protéger les tests par la politique (`paths.protect`) : un nom protégé
  devient illisible, alors que le modèle doit lire les tests pour réparer le
  code ; et la protection porte sur un nom, pas sur un chemin.
- Prendre la révision Git de base comme référence : tout workspace n'est pas
  un dépôt, les tests non suivis y échappent, et `.git` est protégé par
  défaut.
- Signer les approbations : exclu par la décision du stockage hôte ; le
  modèle de menace est un agent confiné, pas un humain qui a le compte.
- Juger par un modèle (LLM juge) ou par le texte des scripts : c'est
  précisément ce que le ticket interdit.
- Arrêter ou suspendre les tâches de fond du modèle pendant le contrôle :
  casse les serveurs de développement et les contrôles qui s'en servent, sans
  couvrir les descendants détachés ; les tampons du noyau couvrent le même
  risque pour les entrées figées.

## Rapport

`report.json` et `report.md` vivent dans le stockage hôte, à côté du contrat
(`~/.smolcoder/harness/<empreinte-du-workspace>/`, amendement du
2026-09-27 de `docs/decision-stockage-hote.md`). Tous deux sont rendus du
même objet, construit depuis le journal, le contrat, l'état du vérificateur
et l'empreinte actuelle du workspace ; ils sont regénérés au début de chaque
tour (état `running` : aucun vert du tour précédent ne reste affiché pendant
que le modèle travaille) et à sa fin. Ils montrent chaque critère, son
contrôle, son dernier verdict, les critères non couverts, l'état du
vérificateur, l'état de la tâche et le déclaratif du modèle. Aucune décision
ne les relit.

Sorties headless sous `--mission` : une ligne `[verdict] {…}` (état, compte
par statut, critères non couverts, péremption, état du vérificateur, chemin
du rapport) ; la ligne `[stats]` ne dit `passed` que pour une réussite dont
la preuve tient encore, et ajoute `verdict`. Code de sortie : 0 seulement
quand la tâche est `verified`, que le tour s'est terminé normalement et que le
rapport est écrit ; 5 sinon (`VERDICT_EXIT_CODE`) ; 4 (suspension) et 3
(contrat) priment.

## Ce qui ne change pas

- Hors `--mission` : rien — ni verdict, ni rapport, ni stockage hôte, même
  boucle de réparation, même `--verify`, mêmes sorties.
- Budget d'essais (`--verify-attempts`, 6 par défaut : une tentative est une
  passe sur la liste des contrôles), annulation (le contrôle en cours est tué,
  aucun verdict n'est journalisé pour lui), contrôles progressifs
  (`checkProgress` reste non décisif et ne laisse aucun verdict).

## Limites connues

- L'ensemble des entrées du vérificateur est une convention : un test rangé
  hors des noms et dossiers reconnus, un script appelé par un autre script ou
  sourcé (`. ./x.sh`), un fichier d'aide importé depuis `src/`, un argument de
  la forme `$VAR` ou un dossier passé en argument ne sont pas figés ; les
  modules profonds de `node_modules` non plus (seuls les outils de
  `node_modules/.bin` nommés le sont). Un fichier de test déposé dans un
  dossier de build (`dist/`) n'est pas figé, et certains lanceurs le trouvent.
- Une donnée ajoutée sous un dossier de tests ne compte pas comme altération
  (un test peut y écrire sa sortie) ; une donnée présente à l'approbation est
  figée, et un test qui la réécrit avec un autre contenu bloque l'acceptation
  jusqu'à nouvelle approbation.
- Échanger puis rétablir un fichier source (hors entrées du vérificateur)
  pendant le contrôle, depuis un processus de fond ou un descendant détaché,
  n'est pas détecté : l'empreinte des fichiers est prise après le contrôle.
- Un code de sortie 128 + N volontaire (Mocha sort avec le nombre d'échecs,
  plafonné à 255) est lu comme un arrêt par signal : `error` au lieu de
  `failed`, jamais `passed`.
- « Zéro test » n'est constaté que par les résumés reconnus : un lanceur
  inconnu qui sort 0 sans test donne `passed` avec un nombre de tests
  « inconnu », affiché comme tel.
- `--approve-verifiers` bénit l'état courant tel quel : l'humain doit relire
  les fichiers que liste la ligne `[mission]` avant de nommer l'empreinte.
- `report.md` est un constat daté (empreinte et date en tête) : un fichier
  modifié hors de smol après sa génération n'y apparaît qu'au tour suivant.
- La décision humaine d'accepter n'a pas encore de geste dédié : elle reste
  `pending`, hors du harnais.
- Preuves sur un seul Mac (macOS 27.0, Apple Silicon), avec un faux modèle ;
  aucun test contre MTPLX.

## Critère de validation

Tests nommés « H04 AC1 » à « H04 AC6 » de `test/proofs.test.js` (dans
`npm test`, fournisseur simulé, faux dossier personnel), et « H04 OS » de
`test/os/e2e.os.test.js` (dans `npm run test:os`, vrai binaire, bac
Seatbelt). Le rouge de chaque garde est montré par mutation du code compilé
(`CHANGELOG-MTPLX.md`, entrée de #9).
