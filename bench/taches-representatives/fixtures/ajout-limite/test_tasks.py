import unittest

from cli import list_tasks


class TasksTest(unittest.TestCase):
    def test_list_tasks_keeps_open_tasks(self):
        tasks = [{"title": "A"}, {"title": "B", "done": True}]
        self.assertEqual([task["title"] for task in list_tasks(tasks)], ["A"])


if __name__ == "__main__":
    unittest.main()
