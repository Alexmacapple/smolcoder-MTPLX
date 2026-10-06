from pricing import subtotal


def total(lines, tax_rate):
    base = subtotal(lines)
    return round(base * (1 + tax_rate), 2)


def render(lines, tax_rate, currency):
    return f"{total(lines, tax_rate):.2f} {currency}"
