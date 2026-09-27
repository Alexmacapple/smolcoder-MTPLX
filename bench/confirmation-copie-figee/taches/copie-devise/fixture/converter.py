def make_converter(rate):
    """Fonction qui convertit un montant en euros au taux donné, au centime près."""

    def convert(amount_eur):
        return round(amount_eur * rate, 2)

    return convert
