def hex_to_rgb(code):
    """« #ff8000 » donne (255, 128, 0) ; le « # » est facultatif."""
    code = code.lstrip("#")
    if len(code) != 6:
        raise ValueError(f"couleur invalide : {code!r}")
    return tuple(int(code[i : i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(red, green, blue):
    """(255, 128, 0) donne « #ff8000 »."""
    for canal in (red, green, blue):
        if not 0 <= canal <= 255:
            raise ValueError(f"canal hors bornes : {canal}")
    return f"#{red:02x}{green:02x}{blue:02x}"
