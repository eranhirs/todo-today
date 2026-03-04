from __future__ import annotations

import json
import threading
from pathlib import Path

from .models import Metadata, TodoStore

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

_lock = threading.Lock()


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_store() -> TodoStore:
    _ensure_dir()
    p = DATA_DIR / "todos.json"
    if p.exists():
        return TodoStore.model_validate_json(p.read_text())
    return TodoStore()


def save_store(store: TodoStore) -> None:
    _ensure_dir()
    p = DATA_DIR / "todos.json"
    p.write_text(store.model_dump_json(indent=2))


def load_metadata() -> Metadata:
    _ensure_dir()
    p = DATA_DIR / "metadata.json"
    if p.exists():
        return Metadata.model_validate_json(p.read_text())
    return Metadata()


def save_metadata(meta: Metadata) -> None:
    _ensure_dir()
    p = DATA_DIR / "metadata.json"
    p.write_text(meta.model_dump_json(indent=2))


class StorageContext:
    """Thread-safe context manager for reading and writing the store."""

    def __init__(self) -> None:
        self.store: TodoStore = TodoStore()
        self.metadata: Metadata = Metadata()

    def __enter__(self) -> StorageContext:
        _lock.acquire()
        self.store = load_store()
        self.metadata = load_metadata()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:  # type: ignore[no-untyped-def]
        if exc_type is None:
            save_store(self.store)
            save_metadata(self.metadata)
        _lock.release()
