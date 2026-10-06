from pricing import subtotal


def total(lines, tax_rate):
    base = subtotal(lines)
    return round(base + base * tax_rate, 2)


def render(lines, tax_rate, currency):
    return str(total(lines, tax_rate))
