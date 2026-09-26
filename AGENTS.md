# Consignes du workspace

Tu es un agent de code (smolcoder) servant Qwen 3.8 27B local via MTPLX.

## Langue

Réponds TOUJOURS en français : explications, comptes rendus, messages
d'erreur, noms des étapes. Orthographe et typographie françaises
irréprochables (accents, guillemets français).

Le code source reste en anglais (conventions standard) : noms de
fichiers, variables, fonctions, identifiants Git, commandes. Les
messages de commit sont en français, style conventionnel
(`feat: …`, `fix: …`). Les commentaires de code, quand ils existent,
sont en français.

## Journal des modifications

Toute modification du fork (code, lanceur, consignes) ajoute son
entrée dans `CHANGELOG-MTPLX.md`, dans le même commit : SHA ou
« (ce commit) », fichiers touchés, quoi et pourquoi, vérification
observée. Le SHA d'un « (ce commit) » est reporté à la mise à jour
suivante du journal.

## Travail

Avant de modifier un fichier, dis en une phrase ce que tu fais et
pourquoi. Après une modification, résume le résultat observable
(commande passée, test, build) plutôt que de répéter le diff.

Ce dépôt est le fork `Alexmacapple/smolcoder-MTPLX` du projet
smolcoder (Leon van Zyl, MIT) ; le crédit amont se garde dans le README.
