def format_eur(cents):
    """Formate un montant en centimes : 123456 donne « 1 234,56 € »."""
    signe = "-" if cents < 0 else ""
    euros, reste = divmod(abs(cents), 100)
    groupes = f"{euros:,}".replace(",", " ")
    return f"{signe}{groupes},{reste:02d} €"
