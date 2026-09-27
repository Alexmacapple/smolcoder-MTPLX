# Décision d'architecture — les fiches de méthode hors du dépôt smolcoder

Statut : rédigée le 2026-09-27 pour le ticket #30, qui confirme sa
recommandation de départ et en précise le mode de lecture. La fusion de la
pull request qui porte cette page vaut acceptation, y compris l'amendement
qu'elle apporte à `docs/decision-stockage-hote.md` (un quatrième type
d'événement au journal). S'en écarter ensuite exige une nouvelle validation.

## Problème

Les fiches de méthode (`docs/skills/`, #20 et #31) ne servent que sur le
dépôt du fork : seul son `AGENTS.md` y renvoie. Sur un autre projet, le
modèle ignore leur existence, et un simple pointeur ne suffirait pas :
`read_file` ne sert que le workspace (`src/sandbox.ts`), une commande qui lit
le clone du fork demande une confirmation en mode edit, et sous `--mission`
le bac Seatbelt refuse le dossier personnel et `~/.smolcoder` (`hostPaths`,
#16). Enfin, rien ne trace quelle fiche, dans quelle version, a été lue,
alors que le guide Anthropic (AI-native SDLC playbook) demande de conserver
cette version avec la spécification.

## Décision

### Où vivent les fiches installées

Dans `~/.smolcoder/fiches/`, sous le dossier de données de smol, à côté de
`harness/` mais hors du stockage du harnais : une copie `<nom>.md` par
fiche et un manifeste `fiches.json`. Le manifeste est fermé (un champ
inconnu le rend illisible) :

```json
{
  "schema": "smolcoder/fiches/v1",
  "source": "/Users/alex/smolcoder/docs/skills",
  "installedAt": "2026-09-27T11:30:07.685Z",
  "fiches": [
    { "name": "tdd", "summary": "nouvelle fonctionnalité ou correctif test-first", "sha256": "…" }
  ]
}
```

Un seul module possède cette grammaire : `src/fiches.ts` (lecture,
validation, index, exception de lecture, installation). Le manifeste est la
liste : un fichier du dossier qu'il ne nomme pas n'est jamais servi.

### Comment elles y arrivent

Par une commande explicite, `smol --install-fiches`, sans argument : elle
copie `docs/skills/` du clone dont le binaire fait partie (le fork, installé
par `npm link`), seule source possible. Le sommaire `docs/skills/index.md`
fait la liste : chaque fiche qu'il nomme doit exister comme fichier
ordinaire de 64 Kio au plus, et chaque fiche du dossier doit y figurer ;
sinon la commande refuse, sans rien écrire. Les copies sont écrites d'abord,
le manifeste en dernier, chacun atomiquement. Le résumé de chaque fiche est
tiré de sa ligne du sommaire (jusqu'au premier « : » ou à la fin de la
première phrase, 120 caractères au plus).

Aucune mise à jour implicite : après la modification d'une fiche, relancer
la commande. Désinstaller, c'est supprimer `~/.smolcoder/fiches/`. La
commande écrit hors du workspace : le scan du mode edit la signale et
demande avant de la lancer (`commandEscapesWorkspace`), et sous `--mission`
le noyau refuse l'écriture dans `~/.smolcoder`.

### Comment le modèle en voit l'index

Un bloc séparé du prompt système, entre le noyau du prompt et les blocs
`AGENTS.md`, hors de leurs plafonds (la phrase de précédence de sécurité et
l'opt-out `SMOL_NO_GLOBAL_AGENTS` sont inchangés). Pour les sept fiches
actuelles, 593 caractères :

```text
Method sheets (fiches) installed on this host, outside the workspace and read-only. Before a task that matches one, read it with read_file, for example {"path": "fiche:diagnostic-bugs"}:
- diagnostic-bugs: bug difficile, régression, « ça casse », lenteur
- tdd: nouvelle fonctionnalité ou correctif test-first
- revue-de-code: relire un diff avant livraison
- verification-finale: après la revue, avant le commit
- implementer: ordre de travail complet d'une implémentation, du cadrage au commit
- conception-modules: vocabulaire des modules profonds
- conflits-git: merge ou rebase en conflit
```

Le bloc n'apparaît que si trois conditions tiennent, vérifiées à
l'ouverture de chaque session (terminal, web, headless) :

- des fiches sont installées et leur manifeste est lisible ; illisible ou
  de schéma inconnu, la session avertit l'utilisateur par une ligne d'état
  et ne dit rien au modèle ;
- le workspace n'annonce pas déjà ses propres fiches : un
  `docs/skills/index.md` et un `AGENTS.md` qui renvoie à `docs/skills/`
  (le dépôt smolcoder lui-même, ses clones et ses worktrees) — pas de
  double index ;
- `SMOL_NO_FICHES=1` n'est pas posé (opt-out, pour un banc qui doit garder
  son prompt).

Sinon, le prompt est identique octet pour octet à celui d'avant #30. Les
sessions déjà ouvertes gardent leur prompt.

### Comment il en lit une

Par une exception nommée et étroite de `read_file` :
`{"path": "fiche:<nom>"}`. Elle n'existe que dans une session dont le prompt
porte l'index. Elle ne sert que :

- un nom du manifeste (minuscules, chiffres et tirets ; `.md` final et
  majuscules tolérés) ; `..`, `/`, un chemin absolu, le manifeste lui-même
  ou un fichier voisin hors liste sont refusés, avec la liste des noms
  valides dans le message ;
- un fichier ordinaire, ouvert sans suivre de lien (`O_NOFOLLOW`) : un lien
  posé à la place d'une fiche est refusé, même vers un contenu identique ;
- un contenu dont le SHA-256 est encore celui de l'installation ; une copie
  modifiée à la main est refusée jusqu'à la réinstallation.

Tout le reste du dossier, et tout le reste hors du workspace, reste fermé :
le chemin absolu d'une fiche est refusé comme avant, seule l'exception
nommée l'ouvre. `list_files` et `search` ne voient pas les fiches ;
`write_file` et `edit_file` sur `fiche:…` sont refusés (lecture seule). La
fiche se lit par tranches comme tout fichier (`offset`).

### Sous `--mission`

La décision d'accès (`src/harness/policy.ts`) reconnaît l'exception : elle
autorise la lecture d'une fiche valide (chemin réel de la copie dans la
décision) et refuse tout le reste avec le motif de `src/fiches.ts`. La
lecture d'une fiche reste permise avant l'approbation, comme toute lecture.
Chaque lecture servie laisse au journal `proofs.jsonl` un événement
`fiche` : le nom, le SHA-256 du contenu servi et l'empreinte du contrat de la
session. L'événement est écrit avant que la fiche soit servie : un journal
qui refuse l'écriture (ligne finale tronquée, borne) empêche la lecture.

### Commandes isolées

Aucun accès nouveau : `~/.smolcoder` reste dans les `hostPaths` refusés au
bac Seatbelt, la politique refuse toute commande qui nomme le stockage hôte,
et la lecture d'une fiche passe par l'hôte, jamais par une commande.

## Coût pour un petit modèle local : une exception plutôt qu'un outil

Un outil dédié (`read_fiche {"name": "tdd"}`) serait plus propre sur le
papier, mais il coûte plus au modèle servi (Qwen 3.8 27B local) :

- un neuvième schéma à chaque requête, et une liste d'outils qui change
  selon que des fiches sont installées ou non (banc, cache de prompt) ;
- un choix de plus pour un petit modèle, qui confond ou sur-appelle les
  outils rares, et deux manières de lire une fiche selon le workspace
  (`read_file` dans le fork, `read_fiche` ailleurs) ;
- plus de plomberie : l'outil devrait entrer dans les modes, la liste fermée
  des outils de préparation de la mission et la politique.

`read_file` est l'outil que le modèle emploie le plus ; l'index montre
l'appel exact à imiter. La liste des outils et leurs schémas restent
identiques, installées ou non. Le prix est un préfixe réservé dans un
paramètre de chemin : il est borné par la section « Limites » ci-dessous.

## Écarts à la recommandation du ticket, déclarés

- La recommandation est confirmée (dossier hôte, commande explicite, index
  court, lecture par l'hôte, commandes non élargies) ; entre ses deux modes
  de lecture, l'exception de `read_file` est retenue.
- L'index est un bloc séparé, pas une ligne sous le plafond du noyau
  global : le noyau est une copie installée à la main de
  `docs/agents-md-global.md`, mesurée par le banc.
- Ajouts : la vérification de l'empreinte à chaque lecture, le refus des
  écritures sur `fiche:…`, le signalement de `--install-fiches` au scan du
  mode edit et l'opt-out `SMOL_NO_FICHES=1`.

## Alternatives écartées

- Copie des fiches dans chaque workspace : écrit dans le projet de
  l'utilisateur (le critère l'interdit), pollue `git status`, laisse le
  modèle modifier ses propres consignes et fait diverger les versions d'un
  projet à l'autre.
- Lien symbolique, dans le workspace vers le clone du fork : `read_file`
  résout les liens et refuse la cible hors du workspace, et poser le lien
  écrit dans le projet. De `~/.smolcoder/fiches` vers `docs/skills/` : les
  fiches suivraient l'arbre de travail du fork (changement de branche,
  worktree, modification en cours) sans installation explicite ni version
  fixe. Un dossier de fiches qui est un lien est donc refusé, comme une
  fiche qui en est un.
- Pointeur absolu seul, dans le noyau global : `read_file` refuse un chemin
  hors du workspace ; une commande `cat` vers le clone demande une
  confirmation en mode edit interactif, est refusée en headless, et sous
  `--mission` Seatbelt la refuse. Le modèle serait invité à lire ce qu'il ne
  peut pas lire, et rien ne tracerait la version lue.
- Index écrit dans le noyau global `~/.smolcoder/AGENTS.md` : deuxième
  source de la liste (le sommaire en est une), présente même quand les
  fiches ne sont pas lisibles, et modification du noyau que mesure le banc.
- Outil dédié `read_fiche` : voir la section précédente.
- Lecture directe dans le clone du fork, sans copie : même défaut que le
  lien (version mouvante), et un chemin de clone à mémoriser qui peut
  changer.
- Ouvrir `~/.smolcoder/fiches` aux commandes isolées (`tools` de la
  politique ou retrait des `hostPaths`) : interdit par le ticket, et ouvre
  le dossier de données de smol au bac.
- Servir tout `.md` du dossier, sans manifeste : un fichier déposé à côté
  des fiches deviendrait lisible ; la liste doit venir de l'installation.
- Noter la révision git du fork dans le manifeste : la lire lance `git`
  hors de l'exécuteur, ce que l'invariant de #15 interdit (le test
  « H03-1 AC1 » l'a rappelé), et l'arbre de travail peut différer du
  commit ; l'empreinte de chaque fiche identifie déjà la version.
- Tracer les lectures hors mission : sans `--mission`, il n'y a pas de
  stockage hôte du harnais où les écrire, et le parcours courant reste
  inchangé.

## Conséquences

- `docs/decision-stockage-hote.md` est amendée : le journal a quatre types
  d'événements, `fiche` étant le quatrième. Le dossier `~/.smolcoder/fiches/`
  n'est pas du stockage du harnais et ne modifie pas cette décision.
- Banc (#13) : `bench/noyau-agents-md/banc.sh` tourne avec le vrai dossier
  personnel. Fiches installées, le prompt des deux bras (avec et sans noyau)
  gagne l'index ; une campagne n'est alors plus comparable à la ligne de
  base archivée tant que le banc ne pose pas `SMOL_NO_FICHES=1`. `bench/`
  est hors de la zone de ce ticket : le réglage reste à faire.
- Le paquet npm ne publie que `dist/` et le README : installé par
  `npm install -g`, smol n'a pas de `docs/skills/` et la commande refuse avec
  un message. Les fiches s'installent depuis un clone du fork.

## Limites

- Dans le dépôt smolcoder lui-même, les fiches se lisent dans
  `docs/skills/` comme des fichiers du workspace : sous `--mission`, ces
  lectures-là ne laissent pas d'événement `fiche`.
- Un fichier du workspace nommé littéralement `fiche:…` est masqué par
  l'exception tant que des fiches sont installées (impossible sous Windows,
  où `:` est interdit dans un nom).
- Le résumé coupé perd parfois une nuance du sommaire (« À lire quand la
  forme d'une interface est en question », pour `conception-modules`).
- L'effet sur la conduite de Qwen n'est pas mesuré : aucun run MTPLX n'a
  vérifié que le modèle lit spontanément la fiche utile à partir de l'index.

## Critère de validation

Cette page est acceptée quand la pull request qui la porte est fusionnée
par Alex. Les tests nommés « #30 » (`test/fiches.test.js`,
`test/os/seatbelt.os.test.js`) en sont la preuve exécutable.
