def total(trip):
    """Total de la note de frais, dans la devise du salarié."""
    return trip.convert(sum(amount for _, amount in trip.expenses))


def lines(trip):
    """Une ligne par dépense, dans la devise du salarié."""
    return [
        f"{label} : {trip.convert(amount):.2f} {trip.currency}"
        for label, amount in trip.expenses
    ]
