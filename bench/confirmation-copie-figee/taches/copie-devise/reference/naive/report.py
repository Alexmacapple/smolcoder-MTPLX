def _convert(trip, amount_eur):
    return round(amount_eur * trip.rates.get(trip.currency), 2)


def total(trip):
    """Total de la note de frais, dans la devise du salarié."""
    return _convert(trip, sum(amount for _, amount in trip.expenses))


def lines(trip):
    """Une ligne par dépense, dans la devise du salarié."""
    return [
        f"{label} : {_convert(trip, amount):.2f} {trip.currency}"
        for label, amount in trip.expenses
    ]
