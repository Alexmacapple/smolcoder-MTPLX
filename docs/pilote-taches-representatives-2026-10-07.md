# Pilote A/A sur des tâches représentatives

## Verdict

Le pilote #72 est **faisable avec variabilité A/A**. Les six essais prévus ont
été exécutés et conservés : cinq réussissent, un échoue au contrôle externe.
Chaque bras compte trois tâches exécutées avec un manifeste complet ; le seuil
de faisabilité préinscrit est donc atteint.

Ce pilote ne compare aucun mécanisme. A1 et A2 sont strictement identiques :
leurs écarts mesurent la variabilité du même Qwen–MTPLX, pas un gain.

## Sources

- Protocole : `bench/taches-representatives/plan.json`.
- Runner et fixtures préinscrits au commit `f8d70db`.
- Résultats bruts locaux, ignorés par Git :
  `bench/taches-representatives/resultats/pilote-20261007/`.
- Analyse reproductible :
  `python3 bench/taches-representatives/banc.py analyser <dossier>`.

Les six manifestes portent le SHA complet
`f8d70db8cb652fb14e053ea5fd04b96cffc84380` et la même empreinte du binaire
construit. Aucun essai n'a été écarté, choisi ou rejoué.

## Effectifs et réussite

- A1 : 3 essais valides et exécutés ; 2 `succes`, 1 `echec_tache`.
- A2 : 3 essais valides et exécutés ; 3 `succes`.
- `multi-fichiers` : A1 échoue, A2 réussit.
- `ajout-limite` : A1 et A2 réussissent.
- `preservation` : A1 et A2 réussissent ; le fichier humain non suivi reste
  intact dans les deux essais.
- Aucun `blocage_harnais`, `refus_securite_attendu` ou
  `mtplx_indisponible` dans ce pilote.

L'échec A1 de `multi-fichiers` est discriminant. Le modèle corrige le calcul,
ne touche qu'à `pricing.py` et `invoice.py`, puis obtient le test visible
vert. Il rend toutefois `EUR 36.00` au lieu de `36.00 EUR`. L'oracle externe
échoue avec le code 1 ; le runner classe donc l'essai `echec_tache` malgré une
sortie Smol de code 0 et un récit de réussite.

## Coûts observés

Pour A1 :

- durée : 36,388 à 119,119 secondes, moyenne 76,104 ;
- appels au modèle : 5 à 8, moyenne 6,33 ;
- appels aux outils : 7 à 9, moyenne 7,67 ;
- tokens générés : 576 à 2 062, moyenne 1 159,33.

Pour A2 :

- durée : 42,088 à 212,079 secondes, moyenne 99,279 ;
- appels au modèle : 5 à 12, moyenne 7,67 ;
- appels aux outils : 6 à 13, moyenne 9 ;
- tokens générés : 589 à 6 905, moyenne 2 789.

Les écarts de durée A2 moins A1 sont de −77,031 secondes pour
`multi-fichiers`, +139,274 secondes pour `ajout-limite` et +7,282 secondes
pour `preservation`. Les deux bras étant identiques, ces écarts interdisent de
prendre un run isolé comme estimation stable du coût.

## Contexte et déroulé

Le serveur annonce une fenêtre de 262 144 tokens. Le plafond du harnais reste
figé à 32 768 par `--ctx`. Les derniers usages de prompt observés vont de
3 128 à 4 088 tokens : le pilote ne teste donc ni la saturation du plafond ni
une réallocation côté serveur.

Les six essais comptent zéro compactage et zéro reprise. La tâche de
préservation enregistre une intervention humaine dans chaque bras ; les autres
n'en enregistrent aucune. Tous les diffs respectent les chemins autorisés.

Le pré-vol a observé `active_requests=0` et le modèle attendu. Le snapshot
portait aussi la trace récente d'un refus mémoire 507 sur une autre requête et
une pression mémoire élevée. Aucun essai du pilote n'a cependant été classé
indisponible ; cette condition machine reste une limite de reproductibilité.

## Limites et suite autorisée

- Trois tâches et un essai par tâche et par bras donnent un signal de
  faisabilité, pas une estimation précise d'un taux de réussite.
- L'écart A/A sur `multi-fichiers` montre qu'une future comparaison doit être
  appariée et répétée ; elle ne doit jamais sélectionner le meilleur run.
- Aucun plan, fiche, plafond alternatif ou autre mécanisme n'a été comparé.
- Aucun scénario de sécurité n'a été joué : le statut de refus attendu est
  seulement exercé par le contrôle déterministe du runner.
- Les résultats bruts restent locaux et ne sont pas une preuve publique tant
  qu'ils ne sont pas transférés avec une décision explicite.

Une étude ultérieure peut réutiliser ce banc en ne changeant qu'un facteur,
avec son propre protocole préinscrit et une règle de décision adaptée à la
variabilité observée ici.
