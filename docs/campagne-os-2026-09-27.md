# Campagne OS du chapeau #12 — isolation macOS

Rédigée le 27 septembre 2026 pour le ticket #18 (H03-4), dernier
sous-ticket du chapeau #12. Le chapeau se ferme quand ses six critères
d'acceptation sont rejoués sur macOS réel, résultats archivés au format du
banc (#13). Cette page tient l'inventaire critère par critère, les
décisions de #18, le protocole de la campagne et son résultat.

## Constat de départ et réduction du ticket

Vérifié sur la base `6c1341f` avant d'écrire : #16 avait déjà branché les
quatre surfaces (`run_command`, tâche de fond, vérifications automatiques,
terminal web) sur l'exécuteur isolé, et décidé que les tests OS lourds
vivent hors de `npm test`, déclenchés par `npm run test:os` ; #17 avait
mesuré l'allow-list et le champ `listen`. `npm test` (264) et
`npm run test:os` (16) étaient verts. Le ticket se réduisait donc à :

- prouver la même frontière par le vrai binaire en headless, en web et dans
  l'interface terminal (le headless n'était prouvé que par la compilation) ;
- prouver un serveur de développement lancé en tâche de fond par le vrai
  binaire, et la ligne `[isolation]` headless avec `listen` (non couverte) ;
- garder l'état de l'isolation visible toute la session ;
- décider du sort des sondes internes `check.ts` et `detect.ts` ;
- jouer et archiver la campagne.

## Inventaire critère par critère

Chaque critère cite les tests qui le prouvent sur macOS réel (fichiers de
`test/os/`, joués par `npm run test:os`). La correspondance est aussi
machine-lisible dans `bench/campagne-os/criteres.json`, et
`test/campagne-os.test.js` vérifie que chaque préfixe désigne exactement un
test existant.

### AC1 — un script du workspace ne lit pas un secret externe, n'altère pas un contrôle protégé, ses sous-processus non plus

- « H03-2 OS AC1 » (`seatbelt.os.test.js`) : un script du workspace et ses
  sous-processus (`sh -c`, `node` et `child_process`, petit-fils détaché
  par `nohup`) ne lisent ni un faux secret hors du workspace, ni le dossier
  personnel, ni le stockage hôte, ni `.env` (aussi `.ENV`, par lien
  symbolique ou lien dur), ni `.git/config` ; l'écriture de `policy.json`,
  de `contract.json`, d'un hook git et du `/tmp` partagé est refusée ; le
  workspace, le TMPDIR borné et `.env.example` restent ouverts.
- « H03-3 OS AC2 » : un `npm test` passe sous la seule allow-list, tandis
  que le jeton de `~/.npmrc`, la configuration des services de Homebrew, les
  données de `/Library`, un terminal du compte et `/dev` restent refusés,
  témoin hôte à l'appui.
- Trou : aucun. Le vrai binaire le confirme en plus (« H03-4 OS AC5
  (headless) » : témoin, dossier personnel, politique et `.env` refusés).

### AC2 — serveur HTTP interdit et API locale non autorisée bloqués, destination autorisée testée positivement

- « H03-2 OS AC2 » : un serveur HTTP de test interdit, une « API locale »
  de la forme de MTPLX, un port fermé et une adresse distante rendent
  `EPERM`, la résolution DNS échoue ; la destination que nomme `network`
  répond, par son adresse et par `localhost`, depuis un sous-processus
  aussi.
- « H03-3 OS AC4 » : un registre npm local ne répond que nommé dans
  `network` (sans lui, aucune requête ne l'atteint) ; un registre distant
  n'est jamais joint.
- Trou : aucun.

### AC3 — un `npm test` de fixture et un serveur de développement autorisé fonctionnent ; fichiers temporaires explicités

- « H03-2 OS AC3 (partial…) » et « H03-3 OS AC2 » : `npm test` de fixture
  sous isolation.
- « H03-3 OS AC1 » : chaque entrée de l'allow-list est nécessaire, et le
  TMPDIR borné l'est aussi (`mktemp` échoue sans lui) : les fichiers
  temporaires nécessaires sont ce TMPDIR privé, posé par l'exécuteur
  (`docs/allowlist-outils.md`).
- « H03-3 OS AC6 » : écoute refusée par défaut ; sur le port que nomme
  `listen`, le serveur répond à l'hôte, un autre port reste `EPERM` ; limite
  observée : l'écoute sur toutes les interfaces est joignable du réseau
  local.
- « H03-4 OS AC3 (headless) » (`e2e.os.test.js`, #18) : le vrai binaire
  headless lance `npm run dev` en tâche de fond ; le serveur répond à l'hôte
  sur le port nommé pendant le run, un autre port rend `EPERM`, la tâche
  meurt avec le run ; la ligne `[isolation]` porte `listen` et la ligne
  d'état dit la limite du réseau local.
- Trou comblé par #18 : le serveur de développement par le vrai binaire et
  en tâche de fond ; la ligne headless de `listen`.

### AC4 — arrêt et délai terminent les descendants, résultat observable

- « H03-2 OS AC4 » : délai de `run_command`, arrêt d'une tâche et
  interruption du terminal web ; chaque descendant (job de fond, enfant node
  et son enfant) est vérifié mort pid par pid, avec un résultat observable
  (`timeout`, `stopped`, `[interrupted]`).
- « H03-2 OS AC4 (known limit) » : un descendant qui se détache par `setsid`
  survit à la destruction du groupe, mais reste confiné (limite connue,
  `docs/decision-backend-isole.md`).
- Trou : aucun.

### AC5 — même frontière pour terminal, web, headless et vérifications automatiques

- « H03-2 OS AC5 » : `run_command`, tâche de fond, vérification automatique
  et terminal web (avec la garde du hub), dans un même processus de test.
- « H03-4 OS AC5 (headless) » (#18) : le vrai binaire headless sous
  `--mission`, piloté par un faux serveur OpenAI-compatible local ; le
  `run_command` du modèle et la vérification `--verify` ne lisent pas le
  témoin, lisible par l'hôte ; le même run sans `--mission` le lit. Les
  sondes de l'hôte n'exécutent aucun programme déposé dans le workspace.
- « H03-4 OS AC5 (web) » (#18) : `smol --web --mission` ; le terminal web
  de la session et le `run_command` du modèle (message de la page) restent
  dans le bac ; l'état exposé à la page porte l'isolation.
- « H03-4 OS AC5 (terminal) » (#18) : l'interface interactive sous un
  pseudo-terminal ; le `run_command` du modèle reste dans le bac, la ligne
  d'état dit encore `isolated` après le tour.
- Trou comblé par #18 : headless, web et terminal par le vrai binaire.

### AC6 — sans backend, aucune commande ; tests OS obligatoires

- « H03-2 OS » : le backend est prêt sur ce Mac (la sonde lance
  `sandbox-exec` et constate le stockage hôte illisible).
- « H03-2 OS AC6 » : `sandbox-exec` absent, ou un faux qui ne confine pas,
  bloquent toute commande ; rien ne tourne.
- Complément hors macOS (`npm test`, `test/sandbox-executor.test.js`,
  « H03-2 AC4 ») : Linux, Windows, sonde en échec, workspace qui contient le
  dossier personnel ; les quatre surfaces refusent avec leur motif.
- Trou : aucun.

## Décisions de #18

- Sondes internes (`check.ts`, `detect.ts`) : elles restent sur l'hôte,
  hors de l'exécuteur ; leur programme n'est plus cherché que dans les
  entrées absolues du PATH, hors du workspace de la mission, depuis un
  dossier courant neutre. Décision, modèle de menace et mesure : section
  « Sondes internes de l'hôte » de `docs/decision-backend-isole.md`.
- Tests OS : `test/os/*.os.test.js`, découverts par `scripts/test-os.cjs`,
  fichiers joués l'un après l'autre ; `npm test` reste exécutable partout.
- Indication : sous `--mission`, l'état de l'isolation reste dans la ligne
  d'état du terminal et dans une pastille de la barre d'état de la page web
  (`docs/profil-mission.md`) ; hors profil, rien ne change.
- Résultats : `bench/campagne-os/resultats/`, ignoré par Git comme
  `bench/noyau-agents-md/resultats/` (même règle, `bench/.gitignore`) ; le
  manifeste de la campagne de référence est cité ci-dessous, les dossiers
  sont à archiver hors du dépôt pour toute qualification.

## Protocole

    bench/campagne-os/campagne.sh

Sans argument, sur le Mac, depuis n'importe quel dossier. Le script :

1. crée un dossier horodaté et unique,
   `bench/campagne-os/resultats/<UTC>-campagne-os.XXXXXX`, et y écrit
   aussitôt un manifeste `blocage_harnais` (« Run initialisé ») ;
2. prend le verrou de campagne (`resultats/.verrou-campagne`, même
   bibliothèque que le banc : `bench/noyau-agents-md/verrou-campagne.sh`) ;
   une campagne déjà active laisse un manifeste `blocage_harnais` et sort 4
   sans rien lancer ;
3. vérifie ses préconditions (macOS, `/usr/bin/sandbox-exec` exécutable,
   npm) ; sinon `blocage_harnais`, sortie 4 ;
4. redirige les journaux de npm dans le dossier du run
   (`npm-journaux/`) et coupe l'avis de mise à jour : rien n'est écrit dans
   `~/.npm` ; compte les entrées du vrai `~/.npm` et du vrai `~/.smolcoder`
   avant et après ;
5. joue `npm test` puis `npm run test:os`, chacun avec deux rapporteurs :
   la sortie lisible (`npm-test.txt`, `test-os.txt`) et une ligne JSON par
   test (`tests-unitaires.jsonl`, `tests-os.jsonl`,
   `bench/campagne-os/rapporteur.mjs`) ;
6. écrit le manifeste final et sort 0 si la campagne vaut `succes`, 1
   sinon.

Aucun modèle n'est appelé : les tests de bout en bout servent leur propre
faux serveur OpenAI-compatible local, et chaque test pose son faux dossier
personnel.

### Manifeste `campagne-os/v1`

`manifeste.json` contient : l'identifiant et les horodatages du run ; le
statut et son motif ; le harnais (`repository_sha`, `working_tree_dirty`
d'après `git status --porcelain`, branche) ; la machine (version et build
de macOS, architecture, versions de node et npm, chemin et présence de
`sandbox-exec`) ; chaque suite (commande, code de sortie, durée en
secondes, nombre de tests, réussis, échoués, sautés, annulés, noms des
échecs) ; chaque critère (identifiant, nature, texte de #12, statut, motif,
durée cumulée de ses tests, et chacun de ses tests avec son fichier, son
statut et sa durée) ; les tests OS qui ne relèvent d'aucun critère ; les
comptes d'entrées du vrai `~/.npm` et du vrai `~/.smolcoder`.

### Statuts

Les cinq statuts du banc (#13), appliqués à chaque critère :

- `refus_securite_attendu` : un critère de refus (AC1, AC2, AC5, AC6) dont
  chaque test a passé ;
- `succes` : un critère fonctionnel (AC3, AC4) dont chaque test a passé ;
- `echec_test` : au moins un de ses tests a échoué ;
- `blocage_harnais` : un test attendu absent, ambigu, sauté ou annulé
  (rien n'est prouvé), ou la campagne n'a pas pu tourner ;
- `mtplx_indisponible` : jamais employé ici, la campagne n'appelle aucun
  modèle.

La campagne vaut `succes` quand ses six critères ont un statut acceptable
et que ses deux suites sortent à 0 sans échec ; `echec_test` dès qu'un test
échoue quelque part ; `blocage_harnais` sinon.

### Contrôle déterministe

`test/campagne-os.test.js`, dans `npm test` : critères et tests OS
correspondants, classement des statuts (réussite, échec, test absent,
sauté ou ambigu, blocage), rapporteur sur une fixture, verrou tenu (rien ne
tourne, verrou intact) et chaîne complète avec un faux npm.
