def open_tasks(tasks):
    return [task for task in tasks if not task.get("done", False)]
