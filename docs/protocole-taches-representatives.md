# Protocole du banc de tâches représentatives

## Décision

Ce banc répond à l'issue #72 : vérifier que Qwen 3.8 27B servi localement par
MTPLX peut mener des tâches de codage représentatives, avec un résultat
contrôlé hors du récit du modèle et un coût observable.

Le pilote est un A/A. Les bras `A1` et `A2` utilisent exactement le même
binaire, le même modèle, les mêmes consignes et le même plafond de contexte.
Il mesure la faisabilité et la variabilité ; il ne compare ni fiche, ni plan,
ni mécanisme du harnais.

La source exécutable du protocole est
`bench/taches-representatives/plan.json`. Elle fixe les consignes, fixtures,
solutions de contrôle, budgets, ordre des six essais et empreintes SHA-256.

## Commandes locales

Contrôle déterministe, sans modèle ni MTPLX réel :

```bash
cd bench/taches-representatives
ruff check *.py fixtures solutions
python3 -m unittest -v test_banc.py
python3 banc.py controler
```

Après un commit propre et `npm run build`, pilote réel :

```bash
cd bench/taches-representatives
python3 banc.py campagne
python3 banc.py analyser resultats/<identifiant-du-pilote>
```

Les résultats vivent sous `bench/taches-representatives/resultats/`, ignoré
par Git. Chaque essai crée son manifeste avant de vérifier les préconditions ;
un arrêt ou un refus ne disparaît donc pas de l'effectif.

## Tâches figées

- `multi-fichiers` : corriger le sous-total et le rendu d'une facture dans
  deux modules, sans modifier le test fourni.
- `ajout-limite` : ajouter un filtrage inclusif par date dans deux modules,
  avec un contrôle d'acceptation externe couvrant les tâches closes et les
  échéances absentes.
- `preservation` : corriger un échec initial tout en préservant octet pour
  octet un fichier humain non suivi.

Chaque fixture devient un dépôt Git jetable étiqueté `reference`. L'oracle
`acceptation.py` reste hors du workspace donné au modèle. La réussite exige
son code de sortie nul, un diff limité aux fichiers autorisés et, pour la
troisième tâche, la conservation exacte du fichier humain.

## Conditions communes et budgets

- Binaire : `dist/index.js` construit depuis le commit propre courant ; SHA
  Git et empreinte de l'arbre `dist/` enregistrés par essai.
- Modèle attendu : `mtplx-qwen38-27b-optimized-speed-fp16`.
- Serveur : `http://127.0.0.1:8000`, sans requête active avant l'essai.
- Plafond du harnais : 32 768 tokens par `--ctx`.
- Délai maximal : 600 secondes par essai.
- Exécution : mode `edit`, dossier personnel et dossier temporaire jetables,
  noyau global copié, fiches désactivées dans les deux bras.
- Concurrence : un verrou local interdit deux campagnes simultanées.
- Rejeu : aucun choix du meilleur résultat et aucun rejeu automatique. Une
  nouvelle campagne porte un nouvel identifiant et reste un nouvel effectif.

## Statuts fermés

- `succes` : exécution complète et oracle externe vert.
- `echec_tache` : essai exécuté, mais code de sortie ou oracle en échec.
- `blocage_harnais` : pièce modifiée, dépôt sale, binaire absent ou mesure
  `[stats]` obligatoire manquante.
- `refus_securite_attendu` : refus sans effet pour une tâche de sécurité. Le
  pilote courant n'en contient pas, mais le runner interdit de le confondre
  avec une réussite fonctionnelle.
- `mtplx_indisponible` : serveur muet, occupé ou modèle différent.

Un essai non exécuté ne peut jamais devenir `succes`.

## Mesures conservées

Chaque manifeste enregistre : identifiant et snapshot du modèle, fenêtre
annoncée, plafond du harnais, derniers tokens de prompt observés, SHA et
empreinte du binaire, code de sortie, durée murale, appels au modèle et aux
outils, tokens générés, compactages, reprises, intervention humaine, fichiers
modifiés et verdict externe. `stdout`, `stderr` et l'espace final compressé
restent à côté du manifeste.

## Règle d'analyse

L'analyse expose les effectifs et statuts par bras, puis le minimum, le
maximum et la moyenne des durées, appels au modèle, appels aux outils et
tokens générés. Elle apparie A1/A2 par tâche pour montrer les écarts de statut
et de durée.

Le pilote est faisable si chaque bras compte au moins deux tâches réellement
exécutées, sans sélection, avec des manifestes complets et des contrôles
externes valides. Un écart A/A mesure de la variabilité ; il ne justifie aucun
changement du harnais.

## Invalidité et limites

Un essai est invalide pour l'analyse de réussite si le protocole diffère de
ses empreintes, si MTPLX est indisponible ou occupé, si un autre modèle est
servi, si le dépôt n'est pas propre ou si `[stats]` est incomplet. Le
manifeste est néanmoins conservé et compté dans l'effectif brut.

Ce banc ne classe pas d'autres modèles, ne mesure pas une allocation de
contexte côté serveur et n'évalue aucun mécanisme contre un témoin. Il ne
tourne ni en CI ni sur une pull request externe ; son lancement reste une
action locale explicite.
