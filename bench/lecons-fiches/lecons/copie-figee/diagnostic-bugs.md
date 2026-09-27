# Diagnostic de bugs difficiles

Discipline pour les bugs durs et les régressions de performance. Ne saute une
phase que si tu peux le justifier explicitement.

Masque tout secret avant d'afficher une commande ou une sortie : écris
`<REDACTED>` à la place, garde les credentials dans des variables
d'environnement.

## Phase 1 : construis une boucle de feedback — c'est LE cœur du skill

Tout le reste est mécanique. Il te faut un signal rouge/vert serré qui devient
rouge sur CE bug précis. Sans lui, relire le code ne te sauvera pas. Dépense un
effort disproportionné ici.

Moyens, dans cet ordre : test qui échoue (au niveau qui atteint le bug) ;
script curl contre le serveur de dev ; invocation CLI avec entrée fixe et diff
de la sortie ; rejeu d'une trace capturée ; mini-harnais jetable (une fonction,
dépendances simulées) ; boucle de fuzz (1 000 entrées aléatoires) ; harnais de
bisection (`git bisect run`) ; boucle différentielle (ancienne version contre
nouvelle, diff des sorties).

Resserre ensuite la boucle : plus rapide (secondes, pas minutes), signal plus
net (asserter le symptôme exact, pas « ne plante pas »), plus déterministe
(figer l'heure, la graine aléatoire, le réseau). Bug non déterministe : vise un
taux de reproduction élevé (boucle 100 fois, parallélise, stresse), pas un
repro propre.

Critère de fin de phase : UNE commande nommée, déjà exécutée au moins une fois
(montre l'invocation et sa sortie), qui peut devenir rouge sur ce bug et verte
une fois corrigé. Si tu te surprends à lire du code pour bâtir une théorie
avant d'avoir cette commande : arrête-toi, c'est exactement l'échec que cette
fiche prévient. Si tu ne peux vraiment pas construire de boucle : dis-le,
liste ce que tu as tenté, demande un artefact capturé — ne théorise pas sans
boucle.

## Phase 2 : reproduis puis minimise

Vérifie que la boucle produit l'échec décrit par l'utilisateur — pas un échec
voisin. Puis réduis au plus petit scénario encore rouge : coupe entrées,
appelants, config et données un par un, en rejouant la boucle après chaque
coupe. Fini quand chaque élément restant est porteur : en retirer un rend la
boucle verte.

## Phase 3 : hypothèses

Formule 3 à 5 hypothèses classées AVANT d'en tester une seule. Chaque
hypothèse doit être falsifiable : « si X est la cause, alors changer Y fera
disparaître le bug ». Pas de prédiction = pas une hypothèse. Montre la liste
classée à l'utilisateur avant de tester (il re-classe souvent en une phrase),
sans te bloquer s'il est absent.

Une valeur qui ne suit pas l'état courant (elle garde sa valeur de départ, ou
un changement fait ici n'est pas vu là) : classe en tête la copie figée —
valeur importée ou calculée une seule fois, objet remplacé alors qu'un autre
module garde l'ancien. Avant de corriger, cherche tous les endroits qui lisent
ou remplacent cet état (`search` sur son nom) ; le correctif fait lire l'état
courant à la source, il ne recopie pas la valeur au seul endroit du symptôme.

## Phase 4 : instrumente

Chaque sonde correspond à une prédiction précise. Une variable à la fois.
Préfère un point d'arrêt ou une inspection ciblée à dix logs ; jamais « tout
logger et grepper ». Tague chaque log de debug d'un préfixe unique
(ex. `[DEBUG-a4f2]`) : le nettoyage final devient un seul grep. Pour une
régression de performance : mesure d'abord (baseline chiffrée), corrige
ensuite — les logs sont le mauvais outil.

## Phase 5 : corrige avec test de régression

Écris le test de régression AVANT le correctif, s'il existe une couture
correcte (un endroit où le test exerce le vrai motif du bug tel qu'il arrive
au site d'appel). Séquence : test rouge → correctif → test vert → rejoue la
boucle de la phase 1 sur le scénario complet. S'il n'existe aucune couture
correcte, c'est un constat en soi : note-le au lieu d'écrire un test qui
donnerait une fausse confiance.

## Phase 6 : nettoyage — obligatoire avant de dire « fini »

Le repro d'origine ne se reproduit plus (boucle rejouée) ; le test de
régression passe (ou l'absence de couture est documentée) ; tous les
`[DEBUG-…]` sont retirés (grep du préfixe) ; les prototypes jetables sont
supprimés ; l'hypothèse gagnante est écrite dans le message de commit.
