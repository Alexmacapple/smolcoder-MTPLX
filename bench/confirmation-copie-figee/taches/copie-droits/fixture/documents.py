def publish(session, document, journal):
    """Publie un document au nom de la session, si elle en a le droit."""
    if not session.can("publish"):
        raise PermissionError(f"{session.user_name} ne peut pas publier {document}")
    journal.append(f"{session.user_name} publie {document}")
