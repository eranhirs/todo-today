from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path

from .models import Metadata, TodoStore

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("TODO_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))

_lock = threading.Lock()


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _atomic_write(p: Path, data: str) -> None:
    """Write to a temp file then rename, so a crash can't leave a partial file."""
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    try:
        with open(fd, "w") as f:
            f.write(data)
            f.flush()
        Path(tmp).replace(p)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_store() -> TodoStore:
    _ensure_dir()
    p = DATA_DIR / "todos.json"
    if p.exists():
        text = p.read_text()
        if text.strip():
            try:
                return TodoStore.model_validate_json(text)
            except Exception:
                logger.warning("Corrupt todos.json, falling back to defaults")
    return TodoStore()


def save_store(store: TodoStore) -> None:
    _ensure_dir()
    _atomic_write(DATA_DIR / "todos.json", store.model_dump_json(indent=2))


def load_metadata() -> Metadata:
    _ensure_dir()
    p = DATA_DIR / "metadata.json"
    if p.exists():
        text = p.read_text()
        if text.strip():
            try:
                return Metadata.model_validate_json(text)
            except Exception:
                logger.warning("Corrupt metadata.json, falling back to defaults")
    return Metadata()


def save_metadata(meta: Metadata) -> None:
    _ensure_dir()
    _atomic_write(DATA_DIR / "metadata.json", meta.model_dump_json(indent=2))


class StorageContext:
    """Thread-safe context manager for reading and writing the store.

    read_only=True skips the write lock — safe because files are written
    atomically (rename), so reads always see a consistent snapshot.
    """

    def __init__(self, read_only: bool = False) -> None:
        self.store: TodoStore = TodoStore()
        self.metadata: Metadata = Metadata()
        self._read_only = read_only

    def __enter__(self) -> StorageContext:
        if not self._read_only:
            _lock.acquire()
        self.store = load_store()
        self.metadata = load_metadata()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:  # type: ignore[no-untyped-def]
        if self._read_only:
            return
        if exc_type is None:
            save_store(self.store)
            save_metadata(self.metadata)
        _lock.release()
