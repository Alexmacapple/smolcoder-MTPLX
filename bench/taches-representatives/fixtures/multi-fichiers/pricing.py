def subtotal(lines):
    return sum(line["unit_price"] for line in lines)
