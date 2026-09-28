# Du fork MTPLX au harnais ALEX

> **À retenir :** ce fork ne cherche pas à rendre Qwen intrinsèquement plus
> intelligent. Il transforme une partie de son travail en opérations
> contrôlables, vérifiables, reprenables et mesurables par l'hôte.

## Lire selon le besoin

| Si votre question est… | Commencez ici | Puis approfondissez |
| --- | --- | --- |
| « Pourquoi ce fork existe-t-il ? » | [Compatibilité MTPLX](#1--faire-fonctionner-qwen-via-mtplx) | [Code de détection](../src/detect.ts#L303-L321) |
| « Que garantit `--mission` ? » | [Contrat et exécution](#3--ne-plus-faire-confiance-au-seul-récit-du-modèle) | [Profil mission](profil-mission.md) |
| « Qu'est-ce qui a été réellement mesuré ? » | [Statuts et limites](#ce-qui-est-livré-mesuré-ou-non-démontré) | [Rapports de banc](#preuves-et-limites) |
| « Que faut-il préserver lors d'une évolution ? » | [Synchroniser l'amont](#synchroniser-lamont-sans-perdre-le-fork) | [Journal des changements](../CHANGELOG-MTPLX.md) |

## Carte du projet

```text
MTPLX et Qwen 3.8 27B
          ↓ API OpenAI-compatible
smolcoder : agent, outils, contexte, interface web
          ↓ profil opt-in --mission
harnais : contrat, politique, isolation, preuves, reprise
          ↓
ALEX : expérience locale, lanceur et ergonomie

à côté : laboratoire (bench, protocoles, manifestes, mesures)
```

Le point de comparaison est smolcoder 0.7.1, commit amont `4ee47b5`.
Le harnais et le laboratoire sont des ajouts du fork ; ALEX désigne la couche
d'expérience, pas un nouveau modèle.

## Les quatre âges

### 1 — Faire fonctionner Qwen via MTPLX

MTPLX expose déjà les points d'entrée OpenAI compatibles. Le correctif
nécessaire au fork consiste surtout à lire `context_length` dans `/v1/models`
au lieu d'imposer le repli à 4 096 jetons. Le code ne fait confiance qu'à une
valeur entière et raisonnable, sinon il conserve ce repli prudent :
[`src/detect.ts`](../src/detect.ts#L303-L321).

Ce raccordement est la part minimale nécessaire pour employer Qwen via MTPLX.

### 2 — Donner des règles de conduite

Le prompt peut charger d'abord `~/.smolcoder/AGENTS.md`, puis l'`AGENTS.md`
du workspace ; les refus de sécurité du noyau global gardent la précédence.
Le chargement, ses plafonds et cette règle sont dans
[`src/prompt.ts`](../src/prompt.ts#L66-L149).

Cette couche guide le modèle, mais ne constitue pas une frontière de sécurité.
Les effets qui doivent être refusés le sont par le harnais, pas par une simple
instruction.

### 3 — Ne plus faire confiance au seul récit du modèle

Sous `--mission`, l'hôte conserve le contrat hors du workspace, l'empreinte,
l'approbation et la politique. Une nouvelle version du contrat devient
proposée ; elle ne conserve pas silencieusement l'ancienne approbation :
[`src/harness/mission.ts`](../src/harness/mission.ts#L210-L330).

Avant chaque effet, la politique rend `allow`, `ask` ou `deny`. Elle refuse
par défaut une politique illisible, les actions inconnues et les chemins
protégés ; les suppressions mesurées demandent une décision humaine :
[`src/harness/policy.ts`](../src/harness/policy.ts#L142-L270).

L'exécuteur construit ensuite le profil macOS Seatbelt depuis la politique et
refuse de lancer quoi que ce soit s'il ne peut pas le construire :
[`src/harness/sandbox-executor.ts`](../src/harness/sandbox-executor.ts#L390-L460).

Les critères d'acceptation ne deviennent jamais vrais parce que le modèle dit
« les tests passent ». Les statuts proviennent de l'issue du processus, des
vérificateurs figés et des empreintes du workspace :
[`src/harness/proofs.ts`](../src/harness/proofs.ts#L1-L110) et
[décision sur les preuves](decision-preuves-acceptation.md).

Enfin, l'intention est journalisée avant l'effet. Sans résultat inscrit après
une interruption, l'effet est `uncertain` et seul l'hôte peut le résoudre :
[`src/harness/resume.ts`](../src/harness/resume.ts#L651-L705).

### 4 — Ne plus faire confiance à nos intuitions

Le laboratoire `bench/` fige le binaire, le protocole et les manifestes, puis
applique une règle de décision écrite avant les essais. Un résultat négatif ou
non concluant est donc une information utile, pas un motif pour réécrire le
récit après coup.

Les fiches de méthode illustrent cette séparation : leur distribution est
proprement implémentée (manifestes, empreintes et lecture étroite), mais leur
gain global sur Qwen n'est pas démontré. Le code de cette distribution est
dans [`src/fiches.ts`](../src/fiches.ts#L1-L150) ; son architecture est décrite
dans [la décision dédiée](decision-fiches-hote.md).

## Ce qui est livré, mesuré ou non démontré

| Mécanisme | Rôle | Statut honnête | Preuve principale |
| --- | --- | --- | --- |
| `context_length` MTPLX | budgeter le vrai contexte | livré | [`detect.ts`](../src/detect.ts#L303-L321) |
| Consignes globales | guider la conduite | livré ; pas une frontière de sécurité | [`prompt.ts`](../src/prompt.ts#L66-L149) · [banc du noyau](banc-noyau-agents-md-2026-09-26.md) |
| Contrat `--mission` | borner et approuver une mission | livré | [profil mission](profil-mission.md) |
| Politique et Seatbelt | décider puis isoler les effets | livré ; verdict borné à la campagne | [revalidation #52](mesure-securite-mission-revalidation-2026-09-28.md) |
| Preuves d'acceptation | distinguer exécution, erreur et récit | livré | [décision](decision-preuves-acceptation.md) |
| Reprise durable | rendre l'incertitude visible | livré | [décision](decision-reprise-durable.md) |
| Plan approuvé | gouverner et tracer le plan | livré, facultatif ; aucun gain démontré | [mesure #29](mesure-plan-approuve-2026-09-27.md) |
| Retours d'outils | expliquer certains échecs | livré ; aucun gain démontré | [mesure #19](mesure-retours-outils-2026-09-27.md) |
| Fiches de méthode | charger une procédure à la demande | livré ; NO-GO global | [étude des fiches](etude-lecons-fiches-2026-09-27.md) |
| ALEX et lanceur | améliorer l'usage local | ergonomie, pas garantie d'agent | [`launch-smol-mtplx.command`](../launch-smol-mtplx.command) |

## Preuves et limites

La première campagne #52 a découvert une suppression de fichiers ordinaires
sous mission. Le correctif a ensuite soumis les formes mesurées de `rm`,
`find -exec rm` et `xargs rm` à la décision humaine. La revalidation a conclu
**PROTÉGÉ** : 15/15 cellules mission valides et 41/41 contrôles synthétiques.
Ce verdict ne couvre ni tous les modèles, ni tous les programmes arbitraires,
ni une suppression dissimulée dans un interpréteur.

- [Rapport de revalidation #52](mesure-securite-mission-revalidation-2026-09-28.md)
- [Protocole de revalidation](protocole-revalidation-securite-mission-2026-09-28.md)
- [Décision d'isolation macOS](decision-backend-isole.md)

Les expériences sur la qualité de conduite ne justifient pas de promesse
générale : le plan approuvé a produit 15 réussites sur 15 dans chaque bras,
avec 2,5 fois plus d'appels au modèle ; les retours d'outils sont NO-GO ; la
confirmation de `copie-figee` est **INCONCLUSIVE**, donc non adoptée.

- [Mesure du plan approuvé](mesure-plan-approuve-2026-09-27.md)
- [Mesure des retours d'outils](mesure-retours-outils-2026-09-27.md)
- [Confirmation `copie-figee`](etude-confirmation-copie-figee-2026-09-27.md)

## Synchroniser l'amont sans perdre le fork

Le fork garde le crédit de l'amont et le commit `4ee47b5` comme base de
comparaison. Pour chaque future synchronisation, il faut d'abord comparer le
delta réel, isoler le changement amont et vérifier que les invariants du
harnais restent intacts. Les fichiers générés `dist/` ne sont jamais la
source d'une correction.

```sh
git diff --stat 4ee47b5..main
npm run build
npm test
```

Le journal [CHANGELOG-MTPLX.md](../CHANGELOG-MTPLX.md) reste la chronologie
canonique : il relie chaque évolution à ses fichiers, son motif et sa preuve.

## Sources à ouvrir ensuite

- Pour l'utilisation : [README](../README.md) et [profil mission](profil-mission.md).
- Pour les décisions : [preuves](decision-preuves-acceptation.md),
  [isolation](decision-backend-isole.md), [reprise](decision-reprise-durable.md)
  et [fiches](decision-fiches-hote.md).
- Pour les résultats et leurs bornes : les rapports de mesure cités ci-dessus.

Cette page est une orientation. Le code, les décisions et les manifestes de
campagne cités restent les sources de vérité de chaque affirmation.
