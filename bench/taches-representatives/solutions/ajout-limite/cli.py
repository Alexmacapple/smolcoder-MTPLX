from tasks import due_before as filter_due_before
from tasks import open_tasks


def list_tasks(tasks, due_before=None):
    if due_before is not None:
        return filter_due_before(tasks, due_before)
    return open_tasks(tasks)
