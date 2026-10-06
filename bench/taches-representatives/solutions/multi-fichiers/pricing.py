def subtotal(lines):
    return sum(line["unit_price"] * line["quantity"] for line in lines)
