# Allow-list de l'empreinte des outils de développement

Statut : rédigée le 2026-09-27 pour le ticket #17 (H03-3, chapeau #12), sur
le backend Seatbelt de #16 (`docs/decision-backend-isole.md`). La fusion de
la pull request qui porte cette page vaut acceptation.

## Principe

Le profil Seatbelt refuse tout par défaut. Ce qu'il accorde au-delà du
workspace et du TMPDIR borné est une liste explicite, `TOOL_FOOTPRINT`
(`src/harness/sandbox-executor.ts`) : une règle par ligne, chaque entrée
nommée. Trois règles la gouvernent :

- une entrée n'existe que si un cas positif mesuré échoue sans elle ;
- la politique par défaut reste la plus stricte : tout élargissement passe
  par un champ explicite de `policy.json`, écrit par l'appelant de confiance,
  jamais par le workspace ;
- une politique qui n'utilise pas les nouveaux champs garde sa version
  (`smolcoder/policy/v1@b8568bb66a5429ae` pour la politique par défaut).

## Méthode de mesure

Expériences jetables du 2026-09-27 sur le Mac cible (macOS 27.0, Apple
Silicon, node 26.9.0 de Homebrew), hors dépôt dans `/private/tmp/smol17-exp/`,
chaque cas comparé à la même commande hors du bac :

- un banc de 35 commandes de développement courantes (`npm test`, `node`,
  `npx tsc`, tube et scripts à shebang, `git`, `make`, `python3`, `perl`,
  `shasum`, `curl`, `date`, `sort`, `tput`, `mktemp`, redirections) ;
- une matrice : chaque autorisation du profil retirée une à une, le banc
  rejoué ; une autorisation dont le retrait ne fait échouer aucun cas n'est
  pas justifiée ;
- le journal unifié du noyau (`log show`, expéditeur `Sandbox`) pendant un
  `npm test` de fixture, pour voir chaque accès refusé.

La preuve rejouable est `npm run test:os` (`test/os/seatbelt.os.test.js`,
tests « H03-3 OS ») ; la liste et la grammaire sont vérifiées partout par
`npm test` (`test/allowlist.test.js`).

## L'allow-list

Chaque entrée : ce qu'elle accorde, le cas positif qui échoue sans elle, et
l'échec observé à son retrait (sortie du test « H03-3 OS AC1 »).

- `process-fork` — créer des processus. `echo a | tr a b` : « fork:
  Operation not permitted ».
- `process-exec` — lancer un programme. Sans elle, `sandbox-exec` ne lance
  même pas le shell : « execvp() of '/bin/sh' failed ».
- `signal` — signaux entre processus du même bac. `sleep 5 & kill $!` :
  « kill: Operation not permitted ».
- `sysctl-read` — lire les paramètres du noyau (nombre de processeurs,
  mémoire). node s'arrête (`Abort trap: 6`) et `os.cpus()` échoue.
- `user-directory` — le seul service Mach accordé, l'annuaire des comptes
  (`getpwuid`). `id -un` rend `501` au lieu du nom du compte.
- `file-metadata` — les métadonnées partout (`stat`, `realpath`). `cd` dans
  un dossier du workspace échoue (« Not a directory »). Elles disent
  l'existence, la taille et la date d'un fichier, jamais son contenu.
- `root-folder` — le contenu de `/`. Sans elle, aucune commande ne démarre.
- `usr` — `/usr` : scripts de `/usr/bin` (`shasum` est un script Perl),
  terminfo, locales. « Can't open perl script "/usr/bin/shasum" ».
- `system` — `/System` : bibliothèques et interpréteurs d'Apple. `perl`
  échoue sur `libperl.dylib`.
- `developer-tools` — `/Library/Developer` : les outils en ligne de commande
  d'Apple, derrière les relais `/usr/bin/git`, `make`, `python3`. « xcrun:
  error: unable to load libxcrun ».
- `homebrew` — `/opt` : node, npm et leurs bibliothèques. node s'arrête sur
  `libnode.147.dylib`.
- `homebrew-openssl` — `/opt/homebrew/etc/openssl@3`, rouvert après le refus
  de `/opt/homebrew/etc` : node de Homebrew lit `openssl.cnf` au démarrage.
  « BIO_new_file:Operation not permitted ».
- `etc` — `/private/etc` : `/etc/hosts` (résolution de `localhost`) et la
  configuration OpenSSL de `curl`. `localhost` rend `ENOTFOUND`, `curl`
  « Auto configuration failed ».
- `timezone` — `/private/var/db/timezone`. `TZ=Europe/Paris date -r 0 +%H`
  rend `00` au lieu de `01`.
- `dev-null` — lire et écrire `/dev/null`. « /dev/null: Operation not
  permitted » (`git` et `perl` l'ouvrent aussi).
- `dev-sources` — lire `/dev/zero`, `/dev/random`, `/dev/urandom`. python3
  s'arrête sans `/dev/urandom` (« Python runtime state: preinitialized »).
- `dev-fd` — lire et écrire `/dev/fd/*` : `> /dev/stderr` et la substitution
  de processus de bash (`cat <(…)`) échouent.

S'y ajoutent, hors de la liste des outils, le workspace et le TMPDIR borné
(lecture et écriture, #16 ; sans TMPDIR, `mktemp` échoue) et les exceptions
de `paths.except`.

## Retraits et resserrements par rapport à #16

Mesurés par la matrice, sans aucun cas en échec à leur retrait :

- informations de processus (`process-info*`) : `ps` est setuid et `pgrep`
  demande le service `sysmond`, tous deux refusés avec ou sans elles ;
- services Mach de notification et de journal (`notification_center`,
  `system.logger`, `logd`) : leur refus est silencieux ;
- lecture de `/bin`, `/sbin` et `/private/var/select` : un programme Mach-O
  s'exécute sans que son fichier soit lisible (mesuré : un binaire compilé
  dans un dossier illisible rend `macho-ok`, son `cat` est refusé), et les
  liens de `/private/var/select` se lisent comme métadonnées ;
- écriture de `/dev/zero`, `/dev/tty`, `/dev/dtracehelper` et leurs
  `file-ioctl` : une commande lancée par l'exécuteur n'a pas de terminal de
  contrôle, et l'enregistrement des sondes DTrace échoue en silence.

Resserrés, pour une raison de sécurité mesurée :

- `/dev` entier devient les nœuds nommés ci-dessus. Avec `/dev` entier, le
  bac ouvrait en lecture un autre terminal du compte (`exec 3</dev/ttys002` :
  « opened-read=yes »), donc pouvait y capter des frappes ; désormais
  « Operation not permitted » ;
- `/Library` entier devient `/Library/Developer` : les données des
  applications, les préférences du système et les journaux ne sont plus
  lisibles. Ruby système (`/Library/Ruby`) n'est plus couvert : hors du banc
  de ce projet, il se rouvre par `tools` ;
- `/opt/homebrew/etc` est refusé (`my.cnf`, `odbc.ini`, `wgetrc` peuvent
  porter des mots de passe), sauf la configuration OpenSSL. Les autres
  configurations de formules (`php.ini`…) se rouvrent par `tools`.
  `/usr/local/etc` (Homebrew sur Intel) n'est pas mesuré sur ce Mac et reste
  tel que #16 l'avait.

Témoin, même tentative sous les deux profils : `ls /opt/homebrew/etc`,
`ls '/Library/Application Support'`, `ls /Library/Preferences`, ouverture
d'un terminal du compte, `cat /bin/ls`, `ls /dev` : « LEAK » sous le profil
de #16, « denied » sous celui de #17.

## Champs de la politique (appelant de confiance)

Tous facultatifs, absents par défaut ; présents, ils changent la version de
la politique ; une valeur invalide rend la politique illisible (rien ne
tourne). Ils ne règlent que le bac des commandes, jamais les outils de
fichiers du modèle, confinés au workspace.

- `tools` : dossiers absolus hors du workspace, lus et exécutés, jamais
  écrits. Mesures : un node installé à la façon de nvm sous le dossier
  personnel se lance mais ne charge pas sa bibliothèque (« file system
  sandbox blocked open() ») ; son dossier nommé, `node -v` et `npm test`
  passent, ses voisins du dossier personnel restent illisibles et écrire
  dans le dossier d'outils est refusé. Le chemin est résolu en chemin réel
  au lancement ; un dossier qui contient le dossier personnel est refusé
  (rien ne tourne). Un lien symbolique vers l'extérieur d'un dossier
  d'outils exige que sa cible soit nommée aussi.
- `git: "read"` : le contenu de `.git` devient lisible par les commandes,
  jamais modifiable ; un autre nom protégé rangé dans `.git` reste fermé.
  L'exécuteur ajoute alors `GIT_CONFIG_GLOBAL=/dev/null` : git ne lit jamais
  la configuration du compte.
- `listen` : ports `localhost:<port>` sur lesquels les commandes peuvent
  écouter (`network-inbound` seul ; `network-bind` ne change rien, mesuré).
- `network` (#16) : destinations `localhost:<port>` joignables en sortie.

## Arbitrages

### git

Mesures, sous la politique par défaut : git s'arrête dès qu'un
`~/.gitconfig` existe (« unable to access '.gitconfig': Operation not
permitted », sortie 128) ; avec `GIT_CONFIG_GLOBAL=/dev/null`, il s'arrête
sur `.git` protégé (« not a git repository »). Avec `.git` rouvert en lecture
seule et la configuration globale vide : `git status --short`,
`git diff <point>`, `git diff <point>...HEAD`,
`git log <point>..HEAD --oneline` et `git rev-parse <point>` fonctionnent —
les commandes que demandent les fiches de revue et de vérification finale
(`docs/skills/`), et que la décision textuelle de la politique laisse
passer — tandis que `git commit` (« index.lock: Operation
not permitted ») et l'écriture d'un hook sont refusés.

Décision : `git: "read"`, champ explicite. Écartés : lire `~/.gitconfig`
(identité, assistants d'identification, parfois un jeton dans une réécriture
d'URL ; git n'en a pas besoin pour lire), rouvrir l'écriture de `.git` (un
hook posé serait exécuté plus tard par l'hôte), et l'accorder par défaut (la
lecture de `.git` a le coût ci-dessous).

Limites mesurées : lire `.git`, c'est lire `.git/config` — git s'arrête si
on le refuse (« fatal: unable to access '.git/config' ») — donc un jeton dans
une URL de remote devient lisible (`git remote -v` l'affiche) : l'appelant
retire ces jetons avant d'accorder `git: "read"`. Un workspace qui est un
worktree garde son dossier git hors du workspace (« not a git repository:
…/worktrees/… ») : l'appelant nomme alors le `.git` du dépôt principal dans
`tools`, en lecture seule. Chaque commande git affiche un avertissement sur
`~/.config/git/ignore` illisible, sans effet.

### Écoute d'un serveur de développement

Mesures : sans règle, `listen` rend `EPERM` ; avec
`(allow network-inbound (local ip "localhost:<port>"))`, le serveur écoute et
l'hôte le joint ; un autre port reste `EPERM`. Mais la règle ne borne pas
l'interface : l'écoute sur `0.0.0.0`, sur `::` et même sur l'adresse du réseau
local est acceptée, et le serveur répond alors à `192.168.1.18` (mesuré
depuis cette machine ; d'un autre poste, selon le pare-feu). Lié à
`127.0.0.1`, il ne répond qu'au loopback.

Décision : accordée, port par port, par `listen` ; aucune par défaut. La
limite est dite ici et dans la ligne d'état de la session (« they may listen
on localhost:5173, which the local network can reach when the server listens
on every interface »), et le headless l'écrit dans `[isolation] {…, "listen":
[…]}`. Le bac qui veut joindre son propre serveur nomme aussi le port dans
`network`. Ce qui reste à #18 : l'indication dans l'interface au-delà de la
ligne d'ouverture et la campagne archivée.

### Registre npm

Seatbelt ne filtre aucun hôte distant (#16) : accorder
`registry.npmjs.org:443` reviendrait à ouvrir tout Internet sur ce port.
Décision : aucun registre distant, jamais (`npm view` vers le registre public
échoue en `ENOTFOUND`). Un registre ou un miroir local, lancé par l'hôte, se
nomme dans `network` ; mesuré : `npm install --registry
http://127.0.0.1:<port> --cache "$TMPDIR/npm-cache"` installe le paquet, et
sans destination nommée aucune requête ne l'atteint.

### Cache npm

`npm test` n'en a pas besoin : npm ignore `~/.npmrc` illisible et n'écrit
pas ses journaux, sans échouer. Une installation, si. Le cache du compte en
écriture est écarté : un processus confiné y déposerait un paquet que npm
installerait ensuite hors du bac. Mesuré : `npm ci --offline` passe quand
`tools` nomme `~/.npm/_cacache`, sans rien écrire dans le cache de l'hôte,
et échoue sans ; une installation en ligne prend un cache borné
(`--cache "$TMPDIR/npm-cache"`). Sur un cache illisible, npm conseille à tort
`sudo chown` (« root-owned files ») : c'est le bac, pas un problème de droits.

## Accès hors liste observés

Journal du noyau pendant un `npm test` de fixture, profil de #17, vrai
dossier personnel : `npm test` rend 0, et chaque accès hors liste est refusé
— services `diagnosticd`, `logd`, `notification_center`, `launchservicesd` ;
lecture des binaires de `/bin` ; `~/.npmrc`, `~/.npm/_logs`, préférences et
`~/.CFUserTextEncoding` du compte ; `/dev/tty`, `/dev/dtracehelper` ;
`/private/tmp` hors du TMPDIR ; socket `syslog`. Aucun n'est nécessaire.

## Limites connues

- Mesures faites sur un seul Mac (Apple Silicon, Homebrew dans
  `/opt/homebrew`). Sur un Mac Intel, node de Homebrew vit sous `/usr/local`
  (couvert par `usr`) ; non mesuré.
- `ps` et `pgrep` ne fonctionnent pas sous isolation : les outils qui
  tuent un arbre par `pgrep` (tree-kill) échouent.
- Ruby système, Java, Python.org et les configurations de formules Homebrew
  ne sont pas couverts par défaut ; l'appelant les rouvre par `tools`.
- `/opt` reste lisible en entier hors de `/opt/homebrew/var` et
  `/opt/homebrew/etc` ; `/usr` en entier (dont `/usr/local/etc`).
- Les limites de #16 demeurent (`docs/decision-backend-isole.md`).
