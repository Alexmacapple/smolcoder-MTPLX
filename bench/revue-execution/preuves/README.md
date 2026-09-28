# Preuves publiées de l'étude #68

Ce dossier contient les 18 essais comptés du protocole `ad5e17b4…` :
pour chacun, la réponse du modèle (`sortie.txt`), la trace des appels
(`erreurs.txt`), le manifeste (`manifeste.json`) et le diff (`diff.txt`).
Il contient aussi `analyse-aa.json` et `analyse-ab.json`, copiés après le
recalcul final. Les sous-dossiers `invalides-*` conservent les fichiers
disponibles des prévols exclus ; leur motif et leur décompte figurent dans
`docs/etude-revue-execution-2026-09-29.md`.

Les instantanés du serveur et la copie du binaire ne sont pas publiés :
ils restent dans `resultats/`, ignoré par Git. Le protocole porte leurs
empreintes utiles. Pour recalculer les scores sur les preuves publiées :

```bash
python3 bench/revue-execution/analyse.py aa --preuves
python3 bench/revue-execution/analyse.py ab --preuves
```

Le calcul écrit les nouvelles synthèses dans `resultats/`, sans modifier
les preuves publiées. Les annotations sont dans `annotations.json` au
niveau parent ; elles sont manuelles et citent les réponses correspondantes.
