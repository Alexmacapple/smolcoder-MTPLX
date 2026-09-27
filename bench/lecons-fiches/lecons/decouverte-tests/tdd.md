# Développement piloté par les tests

La boucle rouge → vert, et ce qui fait qu'elle produit des tests qui valent
d'être gardés.

## Ce qu'est un bon test

Il vérifie un comportement à travers l'interface publique, jamais les détails
d'implémentation. L'implémentation peut changer entièrement ; le test ne
devrait pas. Un bon test se lit comme une spécification : « l'utilisateur peut
payer avec un panier valide » — et il survit aux refactorings.

## Les coutures : où vont les tests

Une couture est la frontière publique où tu observes le comportement sans
entrer dans l'implémentation. Les tests vivent aux coutures, jamais contre les
internes. Avant d'écrire un test, nomme les coutures visées et fais-les
confirmer par l'utilisateur : on ne peut pas tout tester, l'accord préalable
concentre l'effort sur les chemins critiques. Si la forme même de l'interface
est en question, lis d'abord la fiche `conception-modules`.

## Anti-patterns à refuser

- Couplé à l'implémentation : simule des collaborateurs internes, teste des
  méthodes privées, vérifie par un canal parallèle (requête directe en base au
  lieu de l'interface). Signe révélateur : le test casse au refactoring alors
  que le comportement n'a pas changé.
- Tautologique : l'assertion recalcule la valeur attendue comme le code le
  fait (`expect(add(a, b)).toBe(a + b)`), donc passe par construction. La
  valeur attendue vient d'une source indépendante : littéral connu-bon,
  exemple travaillé, spécification.
- Découpage horizontal : écrire tous les tests d'abord, puis toute
  l'implémentation. Les tests en masse vérifient un comportement imaginé.
  Travaille en tranches verticales : un test → une implémentation → répète,
  chaque test répondant à ce que le cycle précédent a appris.

## Règles de la boucle

- Rouge avant vert : écris le test qui échoue d'abord (et vérifie qu'il échoue
  pour la bonne raison), puis juste assez de code pour le faire passer.
- Une tranche à la fois : une couture, un test, une implémentation minimale
  par cycle.
- Le refactoring n'est pas dans la boucle : il appartient à la revue
  (la fiche `revue-de-code`), pas au cycle rouge → vert.

Une fois la tranche finie, joue la suite complète par la commande que
documente le projet (build compris quand ce qui est livré est construit) ;
vérifie dans sa sortie que ton nouveau test y a tourné (le nombre de tests
annoncé a augmenté, ou son nom apparaît) : un test que cette commande ne
lance pas ne protège rien, même s'il passe quand tu l'invoques directement.
S'il manque, range-le selon la convention de la suite (dossier, motif de
nom, liste explicite), puis rejoue-la. Si le projet tient un journal, son
entrée va dans le même commit.
