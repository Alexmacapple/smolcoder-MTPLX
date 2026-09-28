def balance(trip, advance):
    """Reste dû au salarié, dans sa devise : ses dépenses moins l'avance versée."""
    spent = trip.convert(sum(amount for _, amount in trip.expenses))
    return round(spent - advance, 2)
