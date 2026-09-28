# Étude #68 — Simulation des chemins d’exécution en revue de code

## Question

Une consigne courte qui demande de suivre les appels et les branches depuis
le diff améliore-t-elle la détection de défauts fonctionnels par Qwen 3.8
27B servi par MTPLX, sans ajouter de faux positifs ni un coût excessif ?

La fiche de production `docs/skills/revue-de-code.md` n'est pas modifiée par
cette étude. A et A2 servent cette fiche ; B sert la copie
`bench/revue-execution/variante-b.md`, qui ajoute un paragraphe après la
préparation et conserve les trois axes existants. Toutes les séries emploient
le même prompt, le même binaire et le même noyau global.

## Pré-enregistrement

Le protocole courant est `bench/revue-execution/protocole.json`, figé avant
les essais de cette campagne avec l'empreinte SHA-256
`ad5e17b4776a32d48b793951da4c4e11214598222b21f73719358a19f6ecd49e`.
Il nomme le commit de base `0f62027b6cb19afdc0d32ff73cadfdd9c60eeae5`,
le modèle `mtplx-qwen38-27b-optimized-speed-fp16`, les empreintes des
fiches, du noyau et des sources d'exécution du banc. Le script de notation
`analyse.py` et les annotations manuelles ont été ajoutés après A/A ; ils
appliquent la règle déjà figée dans le protocole. La copie du binaire a
l'empreinte d'arborescence
`0a2f85dc8dca7976ab3d8bd370751f0d9ef1c584e2e78cde1308cd23dc47c9ae`.

Trois changements candidats sont joués deux fois en A, A2 et B, soit 18
cellules. Le contrôle A/A précède B. Chaque essai démarre dans un dépôt Git
jetable : un commit et une étiquette `reference` désignent la base ; le
changement candidat reste non commité. Le statut Git et le diff vérifiés sont
fournis dans le prompt identique pour A, A2 et B d'un même cas. Le modèle
travaille en mode `ro` : il peut lire la fiche et les fichiers, mais ne peut
pas lancer de commandes ni écrire. Le binaire est figé, les fiches sont
installées dans un HOME temporaire, et le banc attend que MTPLX soit libre.
Les sorties, erreurs, diff, manifeste, durée, modèle, lecture de la fiche et
mutation éventuelle du workspace sont conservés sous
`bench/revue-execution/resultats/` (ignoré par Git). Une copie publiable des
réponses, traces d'appels, manifestes et diffs est dans
`bench/revue-execution/preuves/`, avec les fichiers disponibles des prévols.
Les instantanés système et le binaire restent locaux. Le délai est de 600
secondes par essai, avec au plus un rejeu d'une cellule non comptée.

Les vérités terrain ont été exécutées avant ce gel par
`test-fixtures.cjs` :

| Cas | Vérité terrain du candidat |
| --- | --- |
| `tarif-zero` | Défaut : `amountFor("free")` lève une erreur au lieu de retourner 0. |
| `reservation-race` | Défaut : deux appels concurrents retournent tous deux `true` pour une place. |
| `reservation-protegee` | Témoin correct : le verrou maintient une seule réussite malgré l'attente asynchrone. |

`test-etude.py` vérifie que les trois candidats produisent un diff non vide
depuis `reference`. Une détection n'est comptée que si la réponse donne la
condition, le chemin d'appel et l'effet ; un autre défaut affirmé sans
reproduction est un faux positif. Les mutations et la durée sont mesurées
séparément. La règle KEEP/REJECT/INCONCLUSIVE exacte est dans le protocole :
KEEP exige au moins deux détections de plus que la meilleure série A/A, sans
nouveau faux positif ni mutation et avec une durée médiane au plus doublée ;
REJECT est déclenché si B ne dépasse pas la moins bonne série A/A ou ajoute
un faux positif ou une mutation. Une cellule manquante rend le verdict
INCONCLUSIVE.

## Prévols exclus du verdict

Le premier protocole (`e17c905e…`) a produit deux revues valides du tarif
zéro, mais la préparation des deux réservations renvoyait un diff vide :
`shutil.copy2` conservait une taille et un horodatage identiques, et Git
réutilisait son cache de statut. Une reproduction isolée donnait 0 ligne de
diff après la copie puis 14 après `touch`. Les dix tentatives ont été
archivées dans `resultats/invalides-prevol-e17c905e/`. Le préparateur
actualise maintenant l'horodatage ; `test-etude.py` passe sur les trois cas.

Le second protocole (`e973f38d…`) limitait chaque essai à 300 secondes.
Le témoin protégé a expiré deux fois, après que Qwen a créé puis corrigé un
script de diagnostic sans terminer sa réponse. Ses sept tentatives, dont
quatre revues terminées sur les cas fautifs, sont archivées dans
`resultats/invalides-delai-e973f38d/`. Aucune n'entre dans les totaux du
protocole courant. Le plafond a été fixé à 600 secondes avant de le rejouer.

Le troisième protocole (`101efb62…`) a expiré à 600 secondes sur le même
témoin. Sa trace montre que Qwen créait et corrigeait plusieurs scripts de
diagnostic, au lieu de conclure sa revue. La tentative et le début du rejeu
sont archivés dans `resultats/invalides-diagnostic-101efb62/`. Le mode de
revue a été ramené à la lecture seule pour isoler la question de la
simulation mentale ; ce changement a été figé sous la nouvelle empreinte
avant tout essai du protocole courant.

## Résultat du contrôle A/A, établi avant B

Les douze cellules du protocole `ad5e17b4…` sont comptées. Le recalcul
`python3 bench/revue-execution/analyse.py aa`, à partir des sorties brutes,
des manifestes et des extraits notés dans `annotations.json`, a écrit
`resultats/analyse-aa.json` **avant** toute exécution B. Ce même calcul a
été rejoué après B lors de la vérification finale ; l'horodatage actuel du
fichier ne démontre donc pas, à lui seul, l'ordre initial des essais :

| Série | Défauts réels trouvés | Faux positifs | Mutations | Durée médiane |
| --- | ---: | ---: | ---: | ---: |
| A | 4/4 | 0 | 0 | 152,71 s |
| A2 | 4/4 | 0 | 0 | 170,49 s |

L'écart A/A de détection est nul. Les quatre passages du témoin protégé
concluent sans défaut établi ; les huit passages sur les deux changements
fautifs donnent la condition, le chemin d'appel et l'effet attendu. Une
réponse ajoute un jugement de style sur le même test `!rate`, sans affirmer
un second défaut fonctionnel ; elle est notée comme doublon, pas comme faux
positif. Toutes les réponses ont lu la fiche, et les empreintes du prompt
sont identiques entre A et A2 pour un même cas. Les durées individuelles
vont de 76,05 à 315,42 secondes : ce coût varie fortement même sans
changement de fiche.

Le score A/A atteint le maximum de quatre détections par série. La règle
KEEP préenregistrée exige deux détections supplémentaires à la meilleure
série A/A : B ne peut donc plus l'atteindre sur ce corpus. La série B reste
nécessaire pour mesurer ses faux positifs, ses durées et appliquer la règle
REJECT/INCONCLUSIVE sur les sorties réelles.

## Résultat A/B

Les six cellules B sont comptées sur le même protocole. La sortie de
`python3 bench/revue-execution/analyse.py ab` recalcule les 18 cellules à
partir des sorties brutes, des manifestes et des annotations citées :

| Série | Défauts réels trouvés | Faux positifs | Mutations | Durée médiane |
| --- | ---: | ---: | ---: | ---: |
| A | 4/4 | 0 | 0 | 152,71 s |
| A2 | 4/4 | 0 | 0 | 170,49 s |
| B | 4/4 | 2 | 0 | 184,74 s |

La médiane des douze cellules A/A réunies est de 164,22 secondes ; celle de
B est supérieure de 12,5 %. Les deux répétitions B du témoin concluent
sans défaut, et les quatre répétitions B des cas fautifs trouvent la cible.
Les six réponses B ont lu la fiche ; aucun essai n'a muté son dépôt jetable
ni tenté une écriture. Pour chaque cas, l'empreinte du prompt est identique
dans A, A2 et B. Les durées B par cas, dans l'ordre des répétitions, sont :

| Cas | B1 | B2 | Détections B | Faux positifs B |
| --- | ---: | ---: | ---: | ---: |
| `tarif-zero` | 101,76 s | 87,94 s | 2/2 | 0 |
| `reservation-race` | 209,35 s | 182,53 s | 2/2 | 2 |
| `reservation-protegee` | 186,95 s | 485,47 s | Témoin correctement écarté 2/2 | 0 |

Les deux faux positifs figurent dans
`preuves/reservation-race-B-1-essai-1/sortie.txt`, axe « standards ».
La réponse nomme « généralité spéculative » le simple déplacement de
`writeAvailable` après `await audit`, sans abstraction ni paramètre ajouté.
Elle nomme aussi « obsession du primitif » le stock numérique dans
`inventory.js`, fichier inchangé par le candidat. Ces deux jugements ne
respectent pas la grille et le périmètre du diff ; la même réponse décrit
correctement la course de réservation à l'axe « spécification ». Les deux
intitulés sont vérifiés dans la sortie brute par `analyse.py`. Une réponse B
du tarif zéro cite quelques lignes décalées ; la condition et l'effet sont
néanmoins corrects, donc la cible reste comptée.

**Verdict pré-enregistré : REJECT.** B ne gagne aucune détection sur A ou A2
et ajoute deux faux positifs. Le paragraphe de
`bench/revue-execution/variante-b.md` n'est donc pas adopté dans la fiche
de production. Le témoin A/A saturé à 4/4 empêchait déjà tout résultat
KEEP sur ce petit corpus ; le verdict vaut pour ces trois cas synthétiques,
ce modèle et ce mode de revue. La simulation mentale est une méthode de
lecture utile pour expliciter des chemins d'appel ; ici, elle n'a pas
amélioré la mesure et ne prouve pas à elle seule l'exécution réelle. Les
vérités terrain proviennent séparément de `test-fixtures.cjs`. Une étude
ultérieure demanderait des cas où la fiche actuelle rate réellement des
branches, une annotation indépendante et un corpus plus large.

## Reproduction et portée des preuves

`preuves/analyse-aa.json` contient le contrôle A/A, recalculé à l'identique
après B ; le recalcul final publié est dans `preuves/analyse-ab.json`. Les
18 réponses, traces d'appels, manifestes et diffs sont publiés dans
`preuves/`, ainsi que les fichiers disponibles des trois prévols invalidés.
`python3 bench/revue-execution/analyse.py ab --preuves` recalcule le verdict
depuis ces éléments et écrit sa sortie dans `resultats/`.
Les résultats complets, instantanés système compris, restent locaux et
ignorés par Git. Les annotations dans `bench/revue-execution/annotations.json` restent
un jugement manuel, contrôlé contre des extraits présents dans les sorties ;
leur présence ne valide pas automatiquement la pertinence du jugement.
`test-fixtures.cjs` prouve les comportements des seuls programmes de test,
pas ceux du fork ni d'autres revues de code. Aucune fiche installée chez
l'hôte, aucun code de production et aucune issue distante n'ont été modifiés.
Le cas d'une cellule B absente a été exercé séparément dans un dossier
temporaire : `analyse.py ab` rend `INCONCLUSIVE`, conformément au protocole.
