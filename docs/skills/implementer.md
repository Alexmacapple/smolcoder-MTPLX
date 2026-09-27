# Implémenter une demande

Ordre de travail pour implémenter une fonctionnalité ou un correctif décrit
par une spécification, un ticket ou une demande claire.

1. Cadre la demande : objectif, périmètre, critère de réussite. Si une
   ambiguïté change le résultat, pose une seule question nette avant de
   commencer.
2. Travaille en tranches verticales, test d'abord quand une couture s'y
   prête : lis `docs/skills/tdd.md` et fais confirmer les coutures visées.
3. En cours de route : vérifie les types régulièrement, joue le fichier de
   test concerné après chaque tranche, et la suite complète une fois à la fin
   (`npm test` = build + suite ; le binaire installé sert `dist/`, donc le
   build fait partie de la preuve).
4. Une fois fini et avant de committer : relis ton propre diff avec
   `docs/skills/revue-de-code.md` (les trois axes), en suivant son cas
   « travail non encore commité » — le diff trois-points ne verrait rien à ce
   stade. Corrige ce que la revue trouve.
5. Vérifie le comportement avec `docs/skills/verification-finale.md` : lance
   ce qui a changé, exerce la demande et deux parcours voisins, un statut par
   critère. Rien n'est corrigé pendant la vérification. Un `failed` ou un
   `error` : corrige ensuite, rejoue la suite, puis reprends à l'étape 4. Un
   `not_run` reste déclaré dans l'entrée du journal.
6. Committe sur la branche courante : message en français à la forme
   nominale, entrée dans `CHANGELOG-MTPLX.md` dans le même commit, jamais de
   ligne d'attribution. Ne pousse pas sans demande explicite.
