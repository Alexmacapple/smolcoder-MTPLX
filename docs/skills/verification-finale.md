# Vérification finale du comportement

Après la revue (fiche `revue-de-code`), avant le commit : faire tourner le
changement et observer s'il fait ce qui est demandé. La boucle de tests
(fiche `tdd`) construit, la revue lit le diff ; ni l'une ni
l'autre n'observe le comportement. Version mono-agent : pas de sous-agent
vérificateur, tu vérifies toi-même, en observateur et non en auteur.

Interdit pendant la vérification : corriger. Aucune édition du code, des
tests, de la configuration ou du journal, aucun commit, aucune commande qui
réécrit le projet (`--fix`, formateur en écriture) — même pour une coquille,
même si le correctif est évident. Tu observes et tu rapportes ; la correction
vient après le rapport, et elle appelle une nouvelle vérification.

## 1. Liste les critères

Même source que l'axe spécification de la revue : sous le profil mission, les
critères du contrat (« Critère observable » de `/mission`, « Acceptance » du
bloc de contrat) ; sinon ceux du ticket (`gh issue view <N>`) ou de la
demande. Numérote-les. Aucun critère écrit : déduis-les de la demande, sous
forme observable, et dis que c'est ton hypothèse.

## 2. Lance ce qui a été modifié

Construis puis démarre la chose changée par le chemin réel de l'utilisateur
(par exemple : construire puis lancer le binaire, une commande, un
serveur), pas une fonction appelée à la main. Montre chaque commande et la
ligne décisive de sa sortie, code de sortie compris. Changement sans
exécutable (documentation, configuration) : exerce-le par son usage réel (la
commande documentée, l'outil qui lit la configuration).

## 3. Exerce le comportement demandé

Écris l'attendu AVANT de lancer : entrée connue, sortie attendue. Joue le
scénario de la demande, compare l'observé à l'attendu, puis un cas limite
(entrée vide, invalide ou maximale).

## 4. Exerce deux parcours voisins

Choisis deux parcours non demandés que le changement peut casser : le même
code appelé ailleurs, une option voisine, le comportement par défaut sans la
nouvelle option. Nomme-les, dis pourquoi ils peuvent régresser, puis
exerce-les comme à l'étape 3.

## 5. Confronte chaque critère

Un statut par critère, vocabulaire du harnais (ticket #9), avec sa preuve
(commande et extrait) :

- `passed` : exercé, observé conforme ;
- `failed` : exercé, observé non conforme — cite l'écart ;
- `not_run` : non exercé (outil, service, accès ou donnée manquant, isolation
  qui bloque, test sauté, suite sans test) — dis ce qui a manqué ;
- `error` : la vérification elle-même a échoué avant de conclure (outil de
  vérification qui plante, délai dépassé) ; le programme vérifié qui plante
  sur l'entrée du critère, c'est `failed`.

Un critère non exercé est `not_run`, jamais `passed` : ni un test vert qui ne
l'exerce pas, ni la lecture du code, ni « ça devrait marcher » n'en tiennent
lieu. Un test vert ne prouve que ses assertions.

## Rapport

Sans rien corriger : les commandes lancées ; attendu contre observé pour le
comportement demandé ; les deux parcours voisins et leur résultat ; le statut
de chaque critère et sa preuve. Termine par une ligne, par exemple :
`Vérification : 4 critères — 2 passed, 1 failed, 1 not_run, 0 error ·
voisins : 2/2 intacts`. La vérification n'est acquise que si tous les
critères sont `passed` et qu'aucun voisin n'a régressé ; sinon dis-le en tête
du rapport, sans adoucir.
