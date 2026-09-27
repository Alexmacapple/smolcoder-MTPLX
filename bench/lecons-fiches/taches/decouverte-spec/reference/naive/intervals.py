def merge_intervals(intervalles):
    """Fusionne les couples (début, fin) qui se chevauchent ou se touchent."""
    fusionnes = []
    for debut, fin in sorted(intervalles):
        if fusionnes and debut <= fusionnes[-1][1]:
            fusionnes[-1] = (fusionnes[-1][0], max(fusionnes[-1][1], fin))
        else:
            fusionnes.append((debut, fin))
    return fusionnes
