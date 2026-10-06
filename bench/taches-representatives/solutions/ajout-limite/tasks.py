from datetime import date


def open_tasks(tasks):
    return [task for task in tasks if not task.get("done", False)]


def due_before(tasks, iso_date):
    limit = date.fromisoformat(iso_date)
    return [
        task
        for task in open_tasks(tasks)
        if task.get("due") and date.fromisoformat(task["due"]) <= limit
    ]
