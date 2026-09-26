# Revue de code à deux axes

Revoir le diff entre `HEAD` et un point fixe fourni par l'utilisateur (commit,
branche, tag). S'il n'en donne pas, demande-le. Version mono-agent : joue les
deux axes l'un après l'autre, puis rapporte-les côte à côte sans les fusionner.

## Préparation

Vérifie que le point fixe se résout (`git rev-parse <point>`) et que le diff
n'est pas vide : `git diff <point>...HEAD` (trois points : comparaison à la
base de fusion) et `git log <point>..HEAD --oneline`.

## Axe 1 — standards

Ce que le dépôt documente comme façon d'écrire le code (ici : `AGENTS.md`, le
journal `CHANGELOG-MTPLX.md` exigé dans le même commit). Un standard documenté
du dépôt prime toujours sur la grille ci-dessous. Ignore ce que l'outillage
vérifie déjà.

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

Retrouve la source : ticket cité dans les messages de commit (`Closes #N`,
lisible par `gh issue view`), fichier de spécification dans `docs/`, ou
demande à l'utilisateur. S'il n'y en a pas : note « pas de spécification
disponible » et saute cet axe.

Rapporte : (a) exigences demandées absentes ou partielles ; (b) comportements
du diff que personne n'a demandés (dérive de périmètre) ; (c) exigences qui
semblent implémentées mais dont l'implémentation paraît fausse. Cite la ligne
de la spécification pour chaque constat.

## Restitution

Deux sections, `## Standards` puis `## Spécification`, sans fusionner ni
re-classer entre elles : un code peut réussir un axe et rater l'autre, et
c'est précisément ce que la séparation révèle. Termine par une ligne : total
de constats par axe et pire constat de chaque axe.
