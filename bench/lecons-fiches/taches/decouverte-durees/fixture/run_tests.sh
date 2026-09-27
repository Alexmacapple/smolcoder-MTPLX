#!/bin/sh
# Suite complète du projet : chaque module de test y est listé.
exec python3 -m unittest tests.test_money tests.test_dates
