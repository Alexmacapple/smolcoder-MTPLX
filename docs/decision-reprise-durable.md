# Décision d'architecture — reprise durable et modifications concurrentes

Ticket #10 (H05), rédigée le 2026-09-27 pendant l'implémentation, sur le
ticket amendé et ses commentaires. Elle applique la page
`docs/decision-stockage-hote.md` (lieu, grammaire, fail-closed) et l'amende
explicitement là où elle ajoute un événement ou un fichier. La fusion de la
pull request qui la porte vaut acceptation.

## Problème

Après une interruption (processus tué, machine arrêtée) ou un commit humain,
une session doit reprendre depuis les effets observables : sans écraser le
travail de l'utilisatrice, sans rejouer aveuglément une action, sans
inventer une conclusion. Avant ce ticket, `Agent.restoreTranscript()` disait
seulement qu'un outil interrompu avait un résultat inconnu ; rien ne gardait
la trace d'une action avant son effet, ni la version des consignes d'une
session, ni ses approbations, ni l'état Git.

## Schéma de reprise versionné

Deux lieux, chacun avec son propriétaire, jamais dupliqués :

- Le snapshot d'une session sauvegardée, `smolcoder/session/v2`
  (`src/session-state.ts`), dans `~/.smolcoder/sessions/<id>.json` comme
  avant : le transcript avec la provenance de chaque message `user`
  (`human` ou `harness`, et pour une demande humaine le texte tapé séparé
  des consignes ajoutées), le plan coché, les consignes réellement chargées
  (texte et empreinte de `~/.smolcoder/AGENTS.md` et de l'`AGENTS.md` du
  workspace), les approbations « always », la vue de l'agent (#19) et la
  révision Git lue dans `.git` sans lancer `git`. Sous le profil mission, une
  simple référence à l'état hôte (empreintes du contrat et du plan approuvé,
  pas consommés, version de la politique).
- Le stockage hôte du profil mission, `~/.smolcoder/harness/<empreinte>/`,
  qui fait foi : contrat, approbation, budget consommé, politique, preuves et
  plan (tickets #8, #9, #11, #29), et désormais le journal d'effets.

Pourquoi deux lieux : seul le hub web sauvegarde un transcript, alors que le
terminal et le headless reprennent un contrat, pas une conversation ; l'état
qui décide (approbation, budget, preuves, effets) ne peut pas vivre dans un
fichier que le hub réécrit toutes les 1,5 seconde. Le snapshot ne recopie
donc de l'état hôte que des empreintes, pour l'affichage.

## Journal d'effets

Décision : il étend `proofs.jsonl`, comme la page du stockage hôte l'avait
prévu, par un sixième type d'événement, `effect` (amendement dans
`docs/decision-stockage-hote.md`). Un seul journal en ajout seul, les mêmes
bornes, la même lecture fail-closed, la même réparation à la main.

- Sont des effets : `write_file`, `edit_file`, `run_command` et `task`
  `start`. Les lectures, la recherche, le plan et la lecture des tâches n'en
  sont pas.
- `intent` est écrit et synchronisé sur le disque (`fsync`) avant l'effet,
  avec un identifiant de douze caractères hexadécimaux, la session,
  l'identifiant de l'appel d'outil et la cible : pour un fichier, son chemin
  relatif, l'empreinte du contenu d'avant (`before`, null s'il est absent) et
  celle du contenu que l'écriture laissera (`expected`, inconnue pour
  `edit_file`) ; pour une commande ou une tâche, la commande. Un journal qui
  refuse l'intention empêche l'effet : l'outil répond une erreur, rien n'est
  changé.
- `result` est écrit après l'effet : `ok` ou `error` selon le retour de
  l'outil, sa première ligne, et pour un fichier l'empreinte constatée
  après. Un résultat qui ne s'écrit pas laisse l'intention seule : la
  session qui l'a vécu n'agit plus, la suivante la trouvera incertaine.
- `uncertain` est écrit par l'hôte à l'ouverture d'une session pour toute
  intention sans résultat, avec l'indice des fichiers et leur empreinte
  actuelle — jamais une conclusion.
- `resolved` est écrit par l'hôte quand l'humain (terminal, page web) ou
  l'appelant headless accepte l'état actuel du workspace comme base.

Écritures atomiques : chaque ligne est écrite puis synchronisée ; les
fichiers d'état (`contract.json`, `policy.json`, snapshot, rapport) restent
écrits par fichier temporaire et renommage. Une dernière ligne tronquée est
un état explicite (`truncated-tail`) : elle n'est jamais lue comme un
résultat, rien ne s'écrit derrière elle, les effets sont suspendus jusqu'à
la réparation à la main (retirer la ligne incomplète), après laquelle
l'intention concernée devient incertaine.

Écarté : un fichier par effet (renommage atomique, mais des milliers de
fichiers et une lecture sans ordre) ; un journal séparé `effects.jsonl`
(deux journaux à borner, relire et réparer) ; réécrire tout le journal à
chaque ligne (coût quadratique).

## Incertitude et réconciliation

Au redémarrage, une écriture sans résultat certain devient `uncertain`. La
réconciliation se limite aux fichiers : pour une écriture, l'hôte compare le
fichier à son empreinte d'avant et à celle attendue, et le dit (« tel
qu'avant : semble non appliquée », « conforme à l'écriture : semble
appliquée », « ni l'un ni l'autre »). Une commande n'a pas d'indice lisible
dans les fichiers ; les tâches de fond vivent en mémoire et sont tuées à la
sortie (`src/tools/tasks.ts`), leur état n'est pas récupérable.

Aucune promesse « exactement une fois », aucune reprise automatique après un
état incertain, même quand l'indice paraît net : un fichier revenu à son
état d'avant peut être un retour en arrière voulu par l'humain, que rejouer
écraserait. Tant qu'une action est incertaine, les écritures, commandes,
tâches et vérifications du profil sont refusées par la porte de la mission ;
les lectures et le plan restent ouverts pour inspecter, et le terminal web
reste à l'humain. Seul l'hôte résout : `/resolve` en terminal et en web,
`--resolve <id>` en headless (identifiant exact de la ligne `[resume]`).
Aucun message, aucune étape de plan, aucun outil du modèle n'écrit dans le
journal : dire « l'action a échoué » ne change rien.

Sur une session web reprise, un appel d'outil resté sans réponse dans le
transcript est raconté par le journal, pas deviné : jamais lancé (aucune
intention, et toute intention précède son effet), terminé (résultat
enregistré : « ne pas le relancer »), ou incertain.

Coupure injectée pour les tests aux trois points du protocole — après
l'intention et avant l'effet, après l'effet et avant le résultat, après le
résultat : en processus par `MissionResume.crash`, et sur le vrai binaire
par la variable `SMOLCODER_TEST_CRASH_AT` (`before-effect`, `after-effect`,
`after-receipt`), qui tue le processus (`SIGKILL`) au point nommé.

## Terminal, headless et web : un seul contrat

Sous `--mission`, la même reprise s'ouvre avec la session, quelle que soit la
surface (`Mission.openResume`, `src/harness/resume.ts`) : terminal et web à
la construction de la session, headless avant toute recherche de modèle. Un
run headless suspendu sort avec le code 6, une ligne `[resume] {…}` sur
stderr donne l'état, les identifiants incertains et l'indice de chacun.

## Migration prudente

Une session sauvegardée avant ce ticket (sans champ `schema`) se lit comme v1
et se migre en mémoire sans rien retirer : l'original est copié en
`sessions/<id>.v1.json` avant la première réécriture, jamais écrasé ; la
provenance de ses messages reste inconnue, jamais devinée ; la version
d'`AGENTS.md` qu'elle utilisait est inconnue et le dit. Un schéma inconnu
(smol plus récent) n'est ni repris ni réécrit. Un transcript illisible est
mis de côté sous un autre nom au lieu d'être écrasé par la session qui
repart vide.

Compatibilité, dite pour qu'il n'y ait pas d'écart silencieux : un binaire
antérieur à #10 lit un journal qui contient un événement `effect` comme
`unknown-schema` — ses verdicts ne comptent plus, son rapport n'est jamais
`verified` —, comme le prévoient les règles de lecture ; il ne lit pas non
plus un snapshot v2 autrement qu'un v1 (les champs ajoutés sont ignorés).
