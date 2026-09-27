import datetime


def is_weekend(day):
    """Vrai pour un samedi ou un dimanche."""
    return day.weekday() >= 5


def next_business_day(day):
    """Premier jour ouvré strictement après day (seuls les week-ends sont chômés)."""
    day += datetime.timedelta(days=1)
    while is_weekend(day):
        day += datetime.timedelta(days=1)
    return day
