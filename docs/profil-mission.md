# Profil mission — contrat de mission et validation avant écriture

Ticket #8 (H01). Implémente la page `docs/decision-stockage-hote.md` pour
le contrat : `~/.smolcoder/harness/<empreinte-du-workspace>/contract.json`
et `proofs.jsonl`, module propriétaire unique `src/harness/store.ts`.

## Nom retenu et opt-in

- `--mission <contrat.json>` ouvre le profil renforcé ; sans cette option,
  le parcours conversationnel courant est strictement inchangé (mêmes
  outils, même menu de commandes, même état web, aucune écriture dans le
  stockage hôte).
- `--approve <empreinte>` est l'approbation explicite de l'appelant
  headless (avec `-p` uniquement).
- `/approve` et `/mission` n'apparaissent en terminal et en web que sous
  le profil.

Pourquoi `--mission` : il nomme le concept du ticket (contrat de mission),
se lit de la même façon en français et en anglais, reste cohérent avec les
options anglaises de la CLI (`--verify`, `--mode`, `--effort`) et ne se
confond ni avec `--mode` (permissions de session) ni avec l'outil `plan`
(la checklist modifiable par le modèle). Écartés : `--contrat` et
`--approuver`, seules options françaises d'une CLI anglaise ; `--profile
strict`, qui ouvrirait un système de profils générique non demandé.

## Le contrat

Un fichier JSON écrit par l'appelant, jamais par le modèle, et **hors du
workspace** : un fichier du workspace (ou un lien posé dans le workspace)
est refusé comme source de contrat. Taille maximale 16 Kio. Schéma fermé :
un champ inconnu est refusé.

```json
{
  "schema": "smolcoder/contract/v1",
  "id": "login-redirect",
  "title": "Corriger la redirection après connexion",
  "problem": "Après connexion, l'utilisateur revient sur l'accueil.",
  "outcome": "La page demandée s'affiche après connexion.",
  "users": "Utilisateurs connectés",
  "constraints": ["pas de nouvelle dépendance"],
  "outOfScope": ["refonte du formulaire"],
  "acceptance": ["npm test passe", "un test couvre la redirection"],
  "openQuestions": [],
  "baseRevision": null,
  "policyRef": null,
  "budgets": { "maxSteps": 60 }
}
```

Obligatoires : `schema`, `id`, `title`, `problem`, `outcome`, `acceptance`
(au moins un critère), `budgets.maxSteps`. Les sept rubriques du format
d'intention s'y retrouvent (problème, résultat attendu, utilisateurs,
contraintes, hors périmètre, critère observable, questions ouvertes).
`workspace` est rempli par l'hôte (chemin réel) ; s'il est fourni, il doit
désigner le même dossier. `policyRef` est réservé à #11.

L'empreinte du contrat est le SHA-256 de sa forme canonique (clés triées),
workspace compris. Toute modification du contrat change l'empreinte : la
version précédente expire (événement `contract` au journal), la nouvelle
n'est qu'une proposition.

## Parcours préparer → approuver → exécuter

- Headless, préparer : `smol -p "…" --mission contrat.json`. Rien ne tourne,
  aucune question n'est posée : la vue Markdown du contrat s'affiche, une
  ligne `[mission] {…}` donne l'état et l'empreinte sur stderr, sortie 3.
- Headless, approuver et exécuter : `smol -p "…" --mission contrat.json
  --approve <empreinte>`. Une empreinte différente est refusée (sortie 3,
  rien d'enregistré). L'approbation vaut pour cette version exacte du
  contrat : un run suivant sans `--approve` s'exécute tant qu'elle tient.
- Terminal et web : la session affiche le contrat ; l'agent lit et planifie,
  toute écriture et toute commande sont refusées à l'exécution. `/approve`
  montre le contrat puis demande une confirmation humaine liée à
  l'empreinte ; `/mission` réaffiche le contrat et son état. En web, le
  contrat ne s'applique qu'aux sessions du workspace visé (`smol --web
  <workspace> --mission contrat.json`) ; un hub déjà lancé ne peut pas le
  recevoir et l'option est refusée.

Avant approbation, seuls `read_file`, `list_files`, `search`, `plan` et
`task` en lecture (`list`, `logs`, `stop`) passent. Le refus est décidé en
relisant le stockage hôte à chaque appel : un message du modèle, une étape
de plan, un fichier du workspace ou un label de ticket n'y changent rien.

## Budget de pas

`budgets.maxSteps` compte les appels au modèle effectués sous un contrat
approuvé. La consommation est persistante (`usage.steps` dans
`contract.json`, hors empreinte) : elle survit aux sessions et suit le même
identifiant de contrat quand une nouvelle version le remplace. Au-delà du
budget, le contrat expire, le tour s'arrête avec une erreur explicite et un
run headless sort en 3. Réapprouver un contrat expiré est refusé ;
l'élargir exige une nouvelle version (nouvelle empreinte) et une nouvelle
approbation. Aucun plafond global de contexte (décision #4) : le schéma
refuse tout autre budget.

## Compaction

Le contrat n'est jamais confié au résumé du modèle : la note de compaction
le reprend en tête, relu dans le stockage hôte au moment de la compaction
(état, empreinte, budget consommé, hors périmètre, critères).

## Codes de sortie headless

- 0 : run terminé sous un contrat toujours approuvé ;
- 1 : erreur d'usage (options, contrat invalide) ou run en échec ;
- 3 : le contrat n'autorise pas l'exécution (proposé, expiré, périmé,
  empreinte refusée, stockage hôte illisible ou de schéma inconnu, journal
  tronqué).

## Limites connues

- L'approbation n'est pas une isolation : après approbation, le mode
  `bypass` exécute sans demander (statut à trancher par #11).
- Pas de verrou : deux sessions simultanées sous le même contrat peuvent
  perdre un débit de pas (verrou mono-écrivain : #10).
- Les vérifications lancées par le harnais lui-même (`--verify`, contrôles
  du projet) ne passent pas par la porte ; elles ne tournent qu'après une
  écriture réussie, donc sous contrat approuvé (point de passage unique :
  #11).
- Les événements `verdict` sont reconnus par la grammaire mais pas encore
  produits (#9).
- Le run headless approuvé est testé par ses briques (autorisation, agent
  non interactif, fournisseur simulé), pas par le CLI réel contre un
  backend.
