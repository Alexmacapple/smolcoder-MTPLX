# Décision d'architecture — le backend d'exécution isolé (macOS)

Statut : rédigée le 2026-09-27 pour le ticket #16 (H03-2, chapeau #12),
après évaluation sur le Mac cible (macOS 27.0, Apple Silicon) ; la fusion
de la pull request qui porte cette page vaut acceptation. S'en écarter
ensuite exige une nouvelle validation.

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

- refus par défaut ; fork, exec, signaux et informations de processus
  limités au même bac ; quatre services Mach (annuaire des comptes,
  notifications, journal) ;
- lecture : métadonnées partout (`stat`, `realpath`), contenu d'une liste
  fixe de racines du système (`/usr`, `/bin`, `/sbin`, `/System`,
  `/Library`, `/opt`, `/private/etc`…), sauf les données de services de
  Homebrew, et du workspace ;
- écriture : le workspace et un TMPDIR privé (créé par session, mode 0700,
  hors du workspace), que l'exécuteur pose dans l'environnement — son seul
  ajout à l'environnement minimal de #11 ;
- noms protégés de la politique : contenu et écriture refusés à toute
  profondeur, sans tenir compte de la casse ; puis leurs exceptions ;
- stockage hôte de smol et fichier de configuration : ni lus ni modifiés,
  même si le workspace les contient ;
- réseau : fermé, sauf les destinations `localhost:<port>` que nomme le
  champ `network` de `policy.json` (absent : aucune) ; aucune écoute.

À sa création, le backend est sondé : `sandbox-exec` présent, profil
accepté, exécution possible, stockage hôte illisible depuis le bac. Un
workspace qui contient le dossier personnel est refusé. Sinon, et sur
Linux ou Windows, toute commande du profil est refusée avec son motif,
jamais relancée dans le shell non isolé. Hors `--mission`, l'adaptateur
hôte reste inchangé.

## Limites connues

- Mécanisme déprécié, sans documentation officielle de son langage : Apple
  peut le retirer ou le changer. La sonde le constate, et le profil
  renforcé bloque alors au lieu de se dégrader.
- Réseau : l'hôte d'une règle n'est que `localhost` ou `*`. Aucun filtrage
  par nom ni par adresse distante ; la voie serait un proxy filtrant côté
  hôte (#17). `localhost:<port>` en sortie vaut cette machine (loopback et
  son adresse sur le réseau local, mesuré). L'écoute sur `localhost:<port>`
  n'est pas bornée au loopback (écoute sur `::` acceptée et joignable du
  réseau local, mesuré) : aucune écoute n'est accordée, un serveur de
  développement sous isolation relève de #17 et #18.
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
- Empreinte des outils (#17) : le dossier personnel étant illisible, git
  s'arrête dès qu'un `~/.gitconfig` existe, et la politique par défaut
  protège `.git` ; les outils installés sous le dossier personnel (nvm,
  `~/.local/bin`) ne se lancent pas ; le `/tmp` partagé n'est pas accordé,
  seul le TMPDIR borné l'est ; un outil qui demande un autre service Mach
  échoue.

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
  proxy ; nouvelle dépendance non essayée ici, piste pour le proxy de #17.
- Le seul scan textuel de `src/sandbox.ts` : faux négatifs connus ; il
  reste le refus précoce, pas la frontière.

## Conséquences pour les tickets

- #17 : allow-list de l'empreinte — binaire node et outils sous le dossier
  personnel, cache npm, `~/.gitconfig` et `.git`, registre par un proxy
  filtrant, écoute d'un serveur de développement ; chaque entrée justifiée
  et testée.
- #18 : indication de l'isolation dans l'interface au-delà de la ligne
  d'ouverture, campagne OS complète archivée au format du banc ; sort des
  sondes internes `src/tools/check.ts` et `src/detect.ts`, restées hors de
  l'exécuteur.

## Critère de validation

Cette page est acceptée quand la pull request qui la porte est fusionnée
par Alex. Les preuves sur macOS réel se rejouent par `npm run test:os`
(`test/os/seatbelt.os.test.js`), hors de `npm test`.
