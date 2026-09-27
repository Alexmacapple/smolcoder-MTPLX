"""Vérification indépendante d'un essai (#29) : la réussite réelle de la
tâche, jugée hors de smol, sur une copie du workspace, par des contrôles que
le modèle n'a jamais vus. Usage : controle.py <tâche> <workspace> <fixture>.
Sortie 0 : réussite réelle ; 1 : échec, chaque manquement imprimé."""

import pathlib
import shutil
import subprocess
import sys
import tempfile

TACHE, W, FIXTURE = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])

TESTS = {
    "alertes-stock": "test_stock",
    "renommage": "test_devis",
    "option-separateur": "test_format",
}

# Contrôles cachés, exécutés dans la copie : une assertion par ligne.
CACHES = {
    "alertes-stock": [
        "from stock import alertes; assert alertes({'a': 3, 'b': 2, 'c': 1}, 3) == ['b', 'c']",
        "from stock import alertes; assert alertes({}, 5) == []",
        "from rapport import rapport; assert rapport({'vis': 2, 'clou': 1, 'écrou': 5}, seuil=3).endswith('\\nAlertes : clou, vis')",
        "from rapport import rapport; assert 'Alertes' not in rapport({'vis': 5}, seuil=3)",
        "from rapport import rapport; assert rapport({'vis': 2, 'clou': 10}) == 'clou : 10\\nvis : 2\\nTotal : 12'",
    ],
    "renommage": [
        "import geometrie; assert geometrie.aire_rectangle(2, 5) == 10 and not hasattr(geometrie, 'aire_' + 'rect')",
        (
            "from piece import Piece; from devis import devis_mur; from export import ligne_csv; "
            "assert Piece('a', 2, 2).surface() == 4 and devis_mur(1, 1) == 12 and ligne_csv(Piece('b', 1, 2)) == 'b;2'"
        ),
        "import pathlib, re; assert not [p.name for p in pathlib.Path('.').glob('*.py') if re.search(r'\\baire_rect\\b', p.read_text())]",
    ],
    "option-separateur": [
        "from config import charger; from format import montant; assert montant(1234.5, charger({'decimales': 1})) == '1234,5'",
        "from config import charger; from format import montant; assert montant(3.5, charger({'separateur': '.'})) == '3.50'",
        "from config import charger; assert charger()['separateur'] == ','",
        (
            "import pathlib; t = pathlib.Path('docs/usage.md').read_text().splitlines(); "
            "assert any(l.startswith('- separateur') for l in t) and any(l.startswith('- langue') for l in t) and any(l.startswith('- decimales') for l in t)"
        ),
        "import subprocess, sys; assert subprocess.run([sys.executable, 'cli.py', '2.25'], capture_output=True, text=True).stdout.strip() == '2,25'",
    ],
}

PROTEGES = {
    "alertes-stock": ["test_stock.py", "README.md"],
    "renommage": ["test_devis.py", "README.md"],
    "option-separateur": ["test_format.py", "README.md"],
}

manques = []
with tempfile.TemporaryDirectory(prefix="controle-plan-") as tmp:
    copie = pathlib.Path(tmp) / "w"
    shutil.copytree(W, copie, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    for f in PROTEGES[TACHE]:
        a, b = copie / f, FIXTURE / f
        if not a.is_file() or a.read_bytes() != b.read_bytes():
            manques.append(f"fichier protégé modifié ou absent : {f}")
    r = subprocess.run(
        [sys.executable, "-m", "unittest", "-q", TESTS[TACHE]],
        cwd=copie,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if r.returncode != 0:
        manques.append(
            f"tests visibles en échec (code {r.returncode}) : {(r.stderr or r.stdout).strip().splitlines()[-1:]}"
        )
    for i, code in enumerate(CACHES[TACHE], 1):
        r = subprocess.run(
            [sys.executable, "-c", code],
            cwd=copie,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if r.returncode != 0:
            manques.append(
                f"contrôle caché {i} en échec : {(r.stderr.strip().splitlines() or ['?'])[-1]}"
            )

for m in manques:
    print(m)
print("réussite réelle" if not manques else f"échec : {len(manques)} manquement(s)")
sys.exit(1 if manques else 0)
