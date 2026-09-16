"""Parity fixture: declaration and import shapes the graph reports for Python."""

from __future__ import annotations

import json
import os, sys
import collections.abc as abc
from pathlib import Path
from os.path import join, dirname
from . import sibling
from .helpers import load

CONSTANT = 3


def top_level(path: Path) -> str:
    def nested(value: str) -> str:
        return value

    return nested(str(path))


async def fetch_all(urls):
    return [url for url in urls]


class Service:
    registry = {}

    def __init__(self, name: str) -> None:
        self.name = name

    def run(self, payload) -> str:
        def helper(value):
            return value

        return helper(json.dumps(payload))

    @staticmethod
    def build() -> "Service":
        return Service(os.getcwd())

    class Inner:
        def ping(self):
            return sys.version


def uses(base=join(dirname(__file__), "x"), extra=(abc, sibling, load)):
    return base, extra
