# Implémenter une demande

Ordre de travail pour implémenter une fonctionnalité ou un correctif décrit
par une spécification, un ticket ou une demande claire.

1. Cadre la demande : objectif, périmètre, critère de réussite. Si une
   ambiguïté change le résultat, pose une seule question nette avant de
   commencer.
2. Travaille en tranches verticales, test d'abord quand une couture s'y
   prête : lis la fiche `tdd` et fais confirmer les coutures visées.
3. En cours de route : vérifie les types régulièrement, joue le fichier de
   test concerné après chaque tranche, et la suite complète une fois à la fin
   (la commande de test que documente le projet ; quand ce qui est livré est
   construit, le build fait partie de la preuve).
4. Une fois fini et avant de committer : relis ton propre diff avec la fiche
   `revue-de-code` (les trois axes), en suivant son cas
   « travail non encore commité » — le diff trois-points ne verrait rien à ce
   stade. Corrige ce que la revue trouve.
5. Vérifie le comportement avec la fiche `verification-finale` : lance ce
   qui a changé, exerce la demande et deux parcours voisins, un statut par
   critère. Rien n'est corrigé pendant la vérification. Un `failed` ou un
   `error` : corrige ensuite, rejoue la suite, puis reprends à l'étape 4. Un
   `not_run` reste déclaré dans ton compte rendu, et dans l'entrée du
   journal si le projet en tient un.
6. Committe sur la branche courante : message au format que documente le
   projet (son `AGENTS.md`), entrée au journal dans le même commit si le
   projet en tient un, jamais de ligne d'attribution. Ne pousse pas sans
   demande explicite.
