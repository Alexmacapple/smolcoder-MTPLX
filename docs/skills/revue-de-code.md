# Revue de code à trois axes

Revoir le diff entre `HEAD` et un point fixe fourni par l'utilisateur (commit,
branche, tag). S'il n'en donne pas, demande-le. Version mono-agent : joue les
trois axes l'un après l'autre, puis rapporte-les côte à côte sans les fusionner.

## Préparation

D'abord `git status --short` : sépare les modifications humaines de celles de
l'agent — la revue ne juge que le changement candidat de l'agent, jamais un
travail humain en cours dans le même dépôt.

Deux cas pour le diff, à ne pas confondre :

- travail non encore commité (revue avant commit) : `git diff <point>` —
  cette forme inclut l'arbre de travail ; le trois-points ne montrerait rien.
  Elle omet les fichiers nouveaux non suivis (`??` dans `git status
  --short`) : lis chacun en entier, il fait partie du changement candidat ;
- branche déjà commitée : `git diff <point>...HEAD` (trois points :
  comparaison à la base de fusion) et `git log <point>..HEAD --oneline`.

Vérifie que le point fixe se résout (`git rev-parse <point>`) et que le diff
retenu n'est pas vide. Cherche enfin un `REVIEW.md` à la racine du projet :
s'il existe, lis-le avant les axes.

## Axe 1 — standards

Ce que le dépôt documente comme façon d'écrire le code (ici : `AGENTS.md`, le
journal `CHANGELOG-MTPLX.md` exigé dans le même commit ; le `REVIEW.md` du
projet s'il existe). Un standard documenté du dépôt prime toujours sur la
grille ci-dessous ; un `REVIEW.md` fixe en outre les niveaux d'importance, les
exclusions et la limite des remarques mineures de toute la revue, sans
supprimer ni fusionner d'axe. Ignore ce que l'outillage vérifie déjà.

Grille de défauts (heuristiques de Fowler — toujours des jugements, jamais des
violations automatiques). Chaque entrée : ce que c'est → comment corriger.

- Nom mystérieux : un nom qui ne révèle pas ce que la chose fait → renomme ;
  si aucun nom honnête ne vient, la conception est floue.
- Code dupliqué : la même logique dans plusieurs endroits du diff → extrais la
  forme commune.
- Envie de données : une méthode qui fouille plus les données d'un autre objet
  que les siennes → déplace-la vers les données qu'elle envie.
- Grappes de données : les mêmes champs voyagent toujours ensemble → un type.
- Obsession du primitif : une chaîne ou un nombre tient lieu de concept métier
  → donne au concept son petit type.
- Switchs répétés : la même cascade de conditions sur le même type revient →
  polymorphisme ou une table partagée.
- Chirurgie au fusil : un changement logique éparpille des éditions dans
  beaucoup de fichiers → regroupe ce qui change ensemble.
- Changement divergent : un module édité pour plusieurs raisons sans rapport →
  scinde, une raison de changer par module.
- Généralité spéculative : abstraction ou paramètre ajouté pour un besoin que
  la spécification n'a pas → supprime, re-inline jusqu'au besoin réel.
- Chaînes de messages : navigation `a.b().c().d()` → cache la promenade
  derrière une méthode du premier objet.
- Intermédiaire creux : une fonction qui ne fait que déléguer → coupe-la.
- Héritage refusé : un sous-type qui ignore l'essentiel de ce qu'il hérite →
  composition.

Rapporte, par fichier : (a) chaque écart à un standard documenté, standard
cité ; (b) chaque défaut de la grille repéré, nommé, extrait cité. Distingue
les écarts durs (standard documenté) des jugements (grille).

## Axe 2 — spécification

Retrouve la source :

- sous le profil mission (`--mission`) : le contrat de mission, tel que
  `/mission` l'affiche et que tu le reçois à chaque tour (bloc « Mission
  contract ») — résultat attendu, hors périmètre, critères d'acceptation
  (« Critère observable », « Acceptance ») ; quand un plan approuvé existe
  (H08, #29), il s'y ajoute ;
- sinon : ticket cité dans les messages de commit (`Closes #N`, lisible par
  `gh issue view`), fichier de spécification dans `docs/`, ou demande à
  l'utilisateur.

S'il n'y en a pas : note « pas de spécification disponible » et saute cet axe.

Rapporte : (a) exigences demandées absentes ou partielles ; (b) comportements
du diff que personne n'a demandés (dérive de périmètre, dont ce que le contrat
met hors périmètre) ; (c) exigences qui semblent implémentées mais dont
l'implémentation paraît fausse ; (d) quand un plan approuvé existe, écarts à
ce plan (fichier touché hors plan, étape ajoutée ou retirée). Cite la ligne
de la spécification, du contrat ou du plan pour chaque constat.

## Axe 3 — sécurité

Ce que le diff expose ou ouvre, même quand standards et spécification sont
respectés. Passe les cinq points un par un sur le diff :

- Secrets et noms protégés : clé, jeton ou mot de passe écrit en clair (code,
  test, journal, message) ; secret passé en argument de commande plutôt que
  par variable d'environnement ; lecture, écriture ou affichage de `.env*`,
  de `.git/`, d'une clé privée ou du dossier de données `~/.smolcoder/`
  (stockage hôte, sessions).
- Commandes shell et injection : chaîne passée à un shell (`bash -c`, `exec`,
  `shell: true`) qui intègre une donnée venue de l'utilisateur, d'un fichier
  ou du modèle ; guillemets manquants, substitution `$(…)`, `eval`.
- Chemins et liens : chemin construit depuis une entrée sans confinement au
  workspace ; `..`, chemin absolu ou lien (symbolique ou dur) qui en sort ou
  atteint un nom protégé ; contrôle fait sur le chemin avant la résolution du
  lien (`realpath`).
- Dépendances ajoutées : nouveau paquet dans `package.json` ou
  `package-lock.json`, script d'installation (`preinstall`, `postinstall`),
  `npx` ou `curl | sh` ; chacune justifiée, sinon signalée.
- Données envoyées au réseau : nouvel appel HTTP, socket, télémétrie ou port
  en écoute ; ce qui part (fichiers, secrets, transcript) et vers où.

Rapporte, par point : l'extrait cité, le risque concret (qui peut faire quoi)
et la correction ; « rien relevé » pour un point passé sans constat. Un secret
trouvé ne se recopie pas : cite le fichier et la ligne, écris `<REDACTED>` à
la place de la valeur.

## Restitution

Trois sections, `## Standards`, `## Spécification` puis `## Sécurité`, sans
fusionner ni re-classer entre elles : un code peut réussir un axe et rater les
autres, et c'est précisément ce que la séparation révèle. Termine par une
ligne : total de constats (et par axe), puis pire constat de chaque axe
(« aucun » pour un axe sans constat, « sauté » sans spécification), par
exemple : `Bilan : 3 constats (standards 0, spécification 1, sécurité 2) ·
standards : aucun · spécification : critère 2 absent · sécurité : jeton en
clair (src/x.ts:12)`.
