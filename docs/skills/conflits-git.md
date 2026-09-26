# Résoudre un conflit de fusion ou de rebase

Pour un merge ou un rebase déjà en cours, avec conflits.

1. Constate l'état réel : historique, fichiers en conflit
   (`git status`, `git log --oneline --left-right HEAD...MERGE_HEAD`).
2. Retrouve les sources de chaque conflit : pourquoi chaque changement a été
   fait, quelle était l'intention d'origine — messages de commit, tickets
   (`gh issue view`), journal du dépôt.
3. Résous chaque zone : préserve les deux intentions quand c'est possible ;
   quand elles sont incompatibles, choisis celle qui correspond au but déclaré
   de la fusion et note le compromis. N'invente jamais de comportement
   nouveau. Résous toujours — jamais d'`--abort`.
4. Découvre et joue les contrôles automatiques du projet (ici : `npm test`,
   build compris). Corrige ce que la fusion a cassé.
5. Termine : indexe tout et committe (entrée au journal dans le même commit) ;
   en rebase, continue jusqu'à ce que tous les commits soient rejoués.
