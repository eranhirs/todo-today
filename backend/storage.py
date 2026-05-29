from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import tempfile
import threading
from pathlib import Path

from .models import Metadata, Project, Todo, TodoStore


# Python 3.8 compatibility: asyncio.to_thread was added in 3.9
if hasattr(asyncio, "to_thread"):
    run_in_thread = asyncio.to_thread
else:
    async def run_in_thread(func, /, *args, **kwargs):
        """Backport of asyncio.to_thread for Python 3.8."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, functools.partial(func, *args, **kwargs))

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("TODO_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))

_lock = threading.Lock()

# Monotonic version counter — bumped on every write, used for ETag/304 on /api/state.
# This lets the frontend skip re-processing unchanged responses.
_state_version = 0

# In-memory cache of parsed pydantic models keyed by file mtime. Loading +
# parsing a 23 MB todos.json takes ~500ms via pydantic-core; with several
# active runs flushing every 5s, that parse cost was the dominant source of
# StorageContext lock-hold time. The cache lets every operation reuse the
# parsed model when the file hasn't changed externally.
#
# Cache invariant: (mtime, text, model) where mtime matches the file's stat.
# A successful write updates the cache so the next read is hot. An exception
# during a write context invalidates the cache so the next read reloads from
# disk (rolling back any partial in-place mutations).
_store_cache: tuple[float, str, TodoStore] | None = None
_metadata_cache: tuple[float, str, Metadata] | None = None


def get_state_version() -> int:
    return _state_version


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


def _load_store_with_text() -> tuple[str, TodoStore]:
    """Load todos.json and return both the on-disk text and the parsed model.

    Uses an in-memory cache keyed by file mtime: when the file hasn't changed
    since the last load, returns the cached text + parsed model in O(1)
    instead of re-parsing 23 MB of JSON.
    """
    global _store_cache
    _ensure_dir()
    p = DATA_DIR / "todos.json"
    if not p.exists():
        return "", TodoStore()
    mtime = p.stat().st_mtime
    if _store_cache is not None and _store_cache[0] == mtime:
        return _store_cache[1], _store_cache[2]
    text = p.read_text()
    if not text.strip():
        return text, TodoStore()
    try:
        model = TodoStore.model_validate_json(text)
        _store_cache = (mtime, text, model)
        return text, model
    except Exception:
        logger.warning("Corrupt todos.json, falling back to defaults")
        return "", TodoStore()


def load_store() -> TodoStore:
    return _load_store_with_text()[1]


def save_store(store: TodoStore) -> None:
    global _state_version, _store_cache
    _ensure_dir()
    text = store.model_dump_json(indent=2)
    p = DATA_DIR / "todos.json"
    _atomic_write(p, text)
    _store_cache = (p.stat().st_mtime, text, store)
    _state_version += 1


def _load_metadata_with_text() -> tuple[str, Metadata]:
    global _metadata_cache
    _ensure_dir()
    p = DATA_DIR / "metadata.json"
    if not p.exists():
        return "", Metadata()
    mtime = p.stat().st_mtime
    if _metadata_cache is not None and _metadata_cache[0] == mtime:
        return _metadata_cache[1], _metadata_cache[2]
    text = p.read_text()
    if not text.strip():
        return text, Metadata()
    try:
        model = Metadata.model_validate_json(text)
        _metadata_cache = (mtime, text, model)
        return text, model
    except Exception:
        logger.warning("Corrupt metadata.json, falling back to defaults")
        return "", Metadata()


def load_metadata() -> Metadata:
    return _load_metadata_with_text()[1]


def save_metadata(meta: Metadata) -> None:
    global _state_version, _metadata_cache
    _ensure_dir()
    text = meta.model_dump_json(indent=2)
    p = DATA_DIR / "metadata.json"
    _atomic_write(p, text)
    _metadata_cache = (p.stat().st_mtime, text, meta)
    _state_version += 1


def _invalidate_caches() -> None:
    """Drop cached parsed models — used after a write context raises so the
    next load re-reads from disk and discards any partial in-place mutations.
    """
    global _store_cache, _metadata_cache
    _store_cache = None
    _metadata_cache = None


class StorageContext:
    """Thread-safe context manager for reading and writing the store.

    read_only=True skips the write lock and gets a fresh deep copy of the
    cached models — safe to mutate without affecting other readers/writers
    or the on-disk state, and the underlying file is written atomically so
    reads always see a consistent snapshot.

    Writers acquire the global lock and mutate the cached model in place;
    on successful exit the cache and disk are both updated, on exception
    the cache is invalidated so the next access reloads from disk.
    """

    def __init__(self, read_only: bool = False) -> None:
        self.store: TodoStore = TodoStore()
        self.metadata: Metadata = Metadata()
        self._read_only = read_only
        self._initial_store_text = ""
        self._initial_metadata_text = ""

    def __enter__(self) -> StorageContext:
        # Both readers and writers get a deep copy of the cached models —
        # readers so they may mutate without affecting other contexts;
        # writers so concurrent readers don't observe in-progress mutations
        # before commit. Pydantic v2's model_copy uses the Rust core and
        # is ~5x cheaper than re-parsing 23 MB of JSON.
        if self._read_only:
            _, store = _load_store_with_text()
            _, metadata = _load_metadata_with_text()
            self.store = store.model_copy(deep=True)
            self.metadata = metadata.model_copy(deep=True)
            return self
        _lock.acquire()
        try:
            self._initial_store_text, cached_store = _load_store_with_text()
            self._initial_metadata_text, cached_metadata = _load_metadata_with_text()
            self.store = cached_store.model_copy(deep=True)
            self.metadata = cached_metadata.model_copy(deep=True)
        except BaseException:
            _lock.release()
            raise
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:  # type: ignore[no-untyped-def]
        if self._read_only:
            return
        try:
            if exc_type is not None:
                # Mutations were on a deep copy that's about to be discarded —
                # the cache was never touched, so nothing to invalidate.
                return
            # Skip writes when nothing changed. _flush_progress and many
            # other handlers touch only one of the two files; rewriting
            # 38 MB on every StorageContext exit was the dominant source
            # of write-lock contention with active runs.
            global _state_version, _store_cache, _metadata_cache
            new_store_text = self.store.model_dump_json(indent=2)
            if new_store_text != self._initial_store_text:
                _ensure_dir()
                p = DATA_DIR / "todos.json"
                _atomic_write(p, new_store_text)
                # Atomic swap of the cache reference. Concurrent readers
                # holding an old reference are unaffected; readers that
                # arrive after this point see the new state.
                _store_cache = (p.stat().st_mtime, new_store_text, self.store)
                _state_version += 1
            new_metadata_text = self.metadata.model_dump_json(indent=2)
            if new_metadata_text != self._initial_metadata_text:
                _ensure_dir()
                p = DATA_DIR / "metadata.json"
                _atomic_write(p, new_metadata_text)
                _metadata_cache = (p.stat().st_mtime, new_metadata_text, self.metadata)
                _state_version += 1
        finally:
            _lock.release()

    # ── Query helpers ─────────────────────────────────────────────

    def get_todo(self, todo_id: str) -> Todo | None:
        """Find a todo by ID. Returns a reference to the in-memory object (mutable)."""
        for t in self.store.todos:
            if t.id == todo_id:
                return t
        return None

    def get_project(self, project_id: str) -> Project | None:
        """Find a project by ID. Returns a reference to the in-memory object (mutable)."""
        for p in self.store.projects:
            if p.id == project_id:
                return p
        return None

    def find_todos(self, predicate) -> list[Todo]:
        """Return all todos matching a predicate function."""
        return [t for t in self.store.todos if predicate(t)]
