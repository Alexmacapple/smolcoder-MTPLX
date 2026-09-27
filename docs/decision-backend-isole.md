# Décision d'architecture — le backend d'exécution isolé (macOS)

Statut : rédigée le 2026-09-27 pour le ticket #16 (H03-2, chapeau #12),
après évaluation sur le Mac cible (macOS 27.0, Apple Silicon) ; la fusion
de la pull request qui porte cette page vaut acceptation. S'en écarter
ensuite exige une nouvelle validation. Amendée par #17 : l'empreinte des
outils devient une allow-list mesurée entrée par entrée
(`docs/allowlist-outils.md`), qui resserre le profil décrit ci-dessous.
Amendée par #46 : le TMPDIR privé vit autant que la session (section « Cycle
de vie du dossier temporaire privé »).

## Problème

La politique d'accès (#11) décide avant l'effet, mais sur le texte des
commandes, avec des faux négatifs connus. Le processus lancé garde les
droits du compte : il lit le dossier personnel, écrit partout, joint le
réseau et les API locales (serveur MTPLX, démon web). Le contrat
d'exécuteur (#15) a posé une couture unique pour les quatre surfaces ; il
manque un backend dont les frontières sont appliquées par le système.

## Modèle de menace

- Adversaire : l'agent confiné (le modèle local, éventuellement trompé par
  un contenu du dépôt) et tout ce qu'il lance — scripts, sous-processus,
  petits-enfants détachés. Il écrit et exécute du code arbitraire dans le
  workspace.
- Hors modèle : un humain hostile qui a accès au compte, root, une faille
  du noyau. L'hôte smol n'est pas confiné : l'inférence MTPLX reste dans
  son processus.
- Biens protégés : les secrets hors du workspace (dossier personnel, SSH,
  jetons, trousseau), le stockage hôte du harnais (contrat, politique,
  preuves) et la configuration, les noms protégés du workspace (`.env`,
  `.git`, dont les hooks exécutés plus tard par l'hôte), le réseau
  (exfiltration, API locales non autorisées), et les sorties du bac par les
  services du système (LaunchServices, launchd, Apple Events).

## Évaluation sur ce Mac

Expériences jetables du 2026-09-27, profil « refus par défaut » écrit à la
main, chaque cas comparé à la même commande hors du bac :

- (a) `echo`, `node -v`, un `npm test` de fixture, l'écriture dans le
  workspace et dans un TMPDIR borné : fonctionnent.
- (b) Lecture d'un témoin hors du workspace, du dossier personnel, de
  `~/.smolcoder`, de `.env` (aussi écrit `.ENV`, par lien symbolique ou par
  lien dur) : `Operation not permitted`. Écriture hors du workspace, dans
  `/private/tmp` hors borne ou dans `.git/hooks` : refusée.
- (c) `curl http://127.0.0.1:9`, et un port loopback où un serveur hôte
  répond pourtant hors du bac : refusés (`EPERM` côté Node, contre
  `ECONNREFUSED` sur un port autorisé mais fermé). Résolution DNS
  (`dns.lookup`, `curl`, `host`) : échec. Port nommé : réponse. Adresse
  distante sur le même port : `EPERM` immédiat.
- (d) Sous-processus (`sh -c`, `child_process`, petit-fils `nohup`) : même
  confinement. `sandbox-exec` exécute le shell dans le même processus (même
  pid, même groupe) : la destruction de l'arbre de #15 s'applique telle
  quelle.
- Services du système, fonctionnels hors du bac, refusés dedans : trousseau
  (`security`), presse-papiers (`pbpaste`), LaunchServices (`lsappinfo`,
  donc `open`), launchd (`launchctl`). Signal vers un processus hôte et
  socket Unix hors du bac : refusés.

`sandbox-exec` est marqué DEPRECATED dans son manuel, mais fonctionne sur
cette version. Aucun blocage rédhibitoire.

## Décision

Seatbelt, par `/usr/bin/sandbox-exec -p <profil>` autour du shell habituel,
derrière le contrat d'exécuteur (`src/harness/sandbox-executor.ts`). Le
profil est généré depuis la politique à chaque lancement, dans cet ordre
(la dernière règle qui correspond l'emporte) :

- refus par défaut ; fork, exec et signaux limités au même bac ; un seul
  service Mach, l'annuaire des comptes (#17 : informations de processus,
  notifications et journal retirés faute de besoin mesuré) ;
- lecture : métadonnées partout (`stat`, `realpath`), contenu de l'allow-list
  de l'empreinte des outils (#17 : `/usr`, `/System`, `/Library/Developer`,
  `/opt`, `/private/etc`, fuseaux horaires, nœuds nommés de `/dev`), sauf les
  données et la configuration de services de Homebrew, et du workspace ;
- écriture : le workspace et un TMPDIR privé (créé par session, mode 0700,
  hors du workspace, supprimé à sa fin depuis #46), que l'exécuteur pose dans
  l'environnement — son seul ajout à l'environnement minimal de #11 ;
- noms protégés de la politique : contenu et écriture refusés à toute
  profondeur, sans tenir compte de la casse ; puis leurs exceptions ;
- stockage hôte de smol et fichier de configuration : ni lus ni modifiés,
  même si le workspace les contient ;
- réseau : fermé, sauf les destinations `localhost:<port>` que nomme le
  champ `network` de `policy.json` (absent : aucune) ; écoute sur les seuls
  ports que nomme `listen` (#17 ; absent : aucune) ;
- champs facultatifs de #17 : `tools` (dossiers d'outils en lecture seule)
  et `git: "read"` (`.git` lisible, jamais modifiable).

À sa création, le backend est sondé : `sandbox-exec` présent, profil
accepté, exécution possible, stockage hôte illisible depuis le bac. Un
workspace qui contient le dossier personnel est refusé. Sinon, et sur
Linux ou Windows, toute commande du profil est refusée avec son motif,
jamais relancée dans le shell non isolé. Hors `--mission`, l'adaptateur
hôte reste inchangé.

## Cycle de vie du dossier temporaire privé (#46)

Le backend crée son dossier `smol-sandbox-*` (mode 0700) dans le dossier
temporaire de l'utilisateur à sa création, avant la sonde ; une sonde qui
échoue le supprime aussitôt. Prêt, le dossier vit autant que la session, et
les commandes y écrivent leurs fichiers temporaires.

La fermeture de l'exécuteur (`close()` dans
`src/harness/sandbox-executor.ts`) :

- tue d'abord ce que le bac fait encore tourner : toute exécution qu'il a
  lancée et dont la fin n'est pas encore constatée (tâche de fond, shell du
  terminal web, commande en cours) ; une exécution finie n'est plus visée,
  son groupe de processus pouvant avoir été réattribué ;
- supprime ensuite le dossier et son contenu : un lien y est retiré, jamais
  suivi ; un sous-dossier dont une commande a retiré les droits est rouvert
  pour le compte avant un second essai ;
- fait refuser toute requête suivante, avec le motif « the session has ended
  and its isolated executor was closed », comme un backend absent : jamais de
  repli sur le shell de l'hôte. L'état de l'isolation passe à « unavailable ».
  Une seconde fermeture ne fait rien, pas même à un dossier réapparu au même
  chemin ;
- dit une suppression impossible (un drapeau `uchg` posé par une commande,
  par exemple) par un avertissement de fin de session, sans la taire.

Points d'appel, chacun après l'arrêt des tâches de fond
(`Session.closeExecution`, ou son équivalent dans `runHeadless`) :

- terminal : `/exit`, ctrl+c deux fois, ctrl+d (`Session.shutdown`), toute
  sortie du processus (`exit`) et les signaux SIGTERM, SIGHUP et SIGINT
  (`src/index.ts`) ;
- headless : fin du run quel qu'en soit le terme (succès, verdict qui ne
  passe pas, suspension sur une décision « ask », sortie par code), sortie du
  processus et signaux ; ces fermetures sont posées dès la création du bac,
  avant tout ce qui peut échouer ;
- web : session fermée ou supprimée depuis la page (sa boucle se termine par
  `Session.shutdown`), session fermée pendant son démarrage (son bac est fermé
  dès qu'il existe), arrêt du hub (`shutdownSync`, aussi sur signal et
  `exit`) ;
- session qui ne s'ouvre pas (reprise durable impossible à ouvrir) : le bac
  déjà créé est fermé avant que l'erreur remonte, sinon chaque nouvel essai
  du hub laisserait un dossier.

Limite, décidée : un processus tué brutalement (`SIGKILL`, plantage, coupure
de courant) n'exécute plus rien ; il laisse au plus son propre dossier, avec
les fichiers temporaires de ses commandes, toujours privé et hors du
workspace. Aucun nettoyage n'est fait au démarrage suivant : rien ne
distingue sûrement le dossier d'une session morte de celui d'une session
vivante (un autre terminal, le hub web, un run headless), et le supprimer
retirerait son TMPDIR à une commande en cours. Un descendant détaché
(`setsid` et double fork), qui survit déjà à la destruction du groupe, peut
aussi recréer le dossier après sa suppression, en y restant confiné (non
mesuré).

Preuves : `test/sandbox-executor.test.js` (tests « #46 AC1 » et « #46 AC2 »,
dans `npm test`) et `test/os/e2e.os.test.js` (tests « #46 OS », vrai binaire
en headless, en web et en terminal, faux serveur local, dans
`npm run test:os`).

## Limites connues

- Mécanisme déprécié, sans documentation officielle de son langage : Apple
  peut le retirer ou le changer. La sonde le constate, et le profil
  renforcé bloque alors au lieu de se dégrader.
- Réseau : l'hôte d'une règle n'est que `localhost` ou `*`. Aucun filtrage
  par nom ni par adresse distante ; la voie serait un proxy filtrant côté
  hôte, que #17 n'a pas retenu : un registre ou un miroir local, lancé par
  l'hôte, se nomme dans `network`. `localhost:<port>` en sortie vaut cette
  machine (loopback et son adresse sur le réseau local, mesuré). L'écoute
  sur `localhost:<port>`
  n'est pas bornée au loopback (écoute sur `::` acceptée et joignable du
  réseau local, mesuré) : #17 l'accorde port par port par `listen`, avec
  cette limite dite dans la ligne d'état (`docs/allowlist-outils.md`).
- Fichiers : ni option d'insensibilité à la casse ni anticipation négative.
  La casse est écrite lettre par lettre ; une exception ne rouvre qu'un nom
  final, jamais le contenu d'un dossier excepté (plus strict que la
  politique). Les métadonnées restent lisibles partout : existence, taille
  et date d'un fichier, ni son contenu ni la liste d'un dossier.
- Processus : un descendant qui se détache (`setsid` et double fork)
  survit à la destruction du groupe, comme sous l'adaptateur hôte, mais
  reste confiné (mesuré). Les lignes de commande des autres processus du
  compte restent lisibles (`KERN_PROCARGS2`), pas leur environnement : ne
  jamais passer un secret en argument.
- Dossier temporaire privé (#46) : supprimé en fin de session sur les trois
  surfaces ; un processus tué brutalement laisse le sien, qu'aucun démarrage
  suivant ne nettoie (section ci-dessus).
- Empreinte des outils (#17, `docs/allowlist-outils.md`) : sous la
  politique par défaut, git s'arrête dès qu'un `~/.gitconfig` existe et
  `.git` reste protégé, les outils installés sous le dossier personnel (nvm,
  `~/.local/bin`) ne chargent ni leurs bibliothèques ni leurs scripts ; le
  `/tmp` partagé n'est pas accordé, seul le TMPDIR borné l'est ; un outil qui
  demande un autre service Mach échoue. L'appelant ouvre git en lecture
  (`git: "read"`) et nomme les dossiers d'outils (`tools`).

## Sondes internes de l'hôte (#18)

Trois lancements restent hors de l'exécuteur, même sous `--mission` : le
contrôle syntaxique qui suit chaque écriture (`src/tools/check.ts` :
`node --check` sur une copie du fichier, compilation Python sans exécution)
et la découverte des serveurs de modèles publiés par des conteneurs
(`src/detect.ts` : `docker ps`, `podman ps`).

Décision : ils restent sur l'hôte. Au regard du modèle de menace, ce ne sont
pas des commandes du projet : leurs arguments sont fixes, jamais un texte du
modèle ; `node --check` et `compile()` analysent sans exécuter (la copie du
fichier vit hors du workspace, en `.cjs` ou `.mjs`, donc sans `package.json`
du projet ; Python tourne en mode isolé `-I`, sans le dossier courant ni les
variables `PYTHON*`) ; `docker ps` ne lit rien du workspace. Dans le bac, ils
perdraient leur objet : `docker ps` joint le démon par une socket Unix que le
bac refuse, et la détection des modèles précède toute session. Leur seule
porte vers le workspace était la recherche du programme, mesurée ouverte :
avec une entrée relative dans le PATH (`node_modules/.bin`, `.`, entrée vide)
et le workspace pour dossier courant, un `python3` ou un `docker` déposé par
l'agent tournait sur l'hôte, hors du bac, au prochain contrôle d'un `.py` ou à
la prochaine détection. Désormais (`src/harness/host-probe.ts`) : programme
cherché dans les seules entrées absolues du PATH, hors du workspace de la
mission (inscrit par le point d'entrée sous `--mission`, et passé par le
contrôle syntaxique), dossier courant neutre (le dossier temporaire du
système). Preuve : `test/host-probes.test.js` (dans `npm test`), qui dépose
des programmes piégés dans le workspace, des sources dont l'exécution laisse
une trace, et vérifie qu'aucune trace n'apparaît tandis que les sondes
tournent encore (erreur de syntaxe détectée, `docker` légitime lancé) ; le
binaire réel est éprouvé par `test/os/` (campagne de #18).

Limites : hors profil, une entrée absolue du PATH qui pointe dans le
workspace reste le choix de l'utilisateur ; les sondes gardent le reste de
l'environnement de l'hôte (elles ne lancent pas de code du projet).

## Alternatives écartées

- Conteneur ou machine virtuelle (Docker Desktop, Lima, `container`
  d'Apple) : noyau Linux, les outils macOS du projet ne s'y lancent pas,
  dépendance lourde.
- App Sandbox : réservée aux applications signées dotées d'entitlements,
  pas aux sous-processus arbitraires d'un CLI.
- Endpoint Security ou Network Extension : entitlements d'Apple et
  extension système, hors de portée d'un CLI.
- Compte système dédié (`sudo -u`) : exige l'administration du Mac et ne
  ferme pas le réseau.
- `@anthropic-ai/sandbox-runtime` : repose sur le même Seatbelt, plus un
  proxy ; nouvelle dépendance non essayée ici ; #17 n'a pas eu besoin d'un
  proxy.
- Le seul scan textuel de `src/sandbox.ts` : faux négatifs connus ; il
  reste le refus précoce, pas la frontière.

## Conséquences pour les tickets

- #17 : allow-list de l'empreinte, livrée dans `docs/allowlist-outils.md` —
  binaire node et outils sous le dossier personnel (`tools`), cache npm
  (lecture seule par `tools`, ou borné au TMPDIR), `.git` en lecture seule
  (`git: "read"`, `~/.gitconfig` jamais lu), registre seulement comme
  destination loopback nommée, écoute d'un serveur de développement
  (`listen`) ; chaque entrée justifiée et testée.
- #18 : indication de l'isolation dans l'interface au-delà de la ligne
  d'ouverture (ligne d'état du terminal, pastille de la page web), sondes
  internes laissées sur l'hôte (section ci-dessus), vrai binaire éprouvé de
  bout en bout, campagne OS archivée au format du banc : inventaire et
  résultat dans `docs/campagne-os-2026-09-27.md`.

## Critère de validation

Cette page est acceptée quand la pull request qui la porte est fusionnée
par Alex. Les preuves sur macOS réel se rejouent par `npm run test:os`
(`test/os/*.os.test.js` : le backend dans `seatbelt.os.test.js`, le vrai
binaire en headless, web et terminal dans `e2e.os.test.js`, #18), hors de
`npm test`.
