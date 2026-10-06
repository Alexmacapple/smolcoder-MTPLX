def endpoint(base_url, path):
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"
