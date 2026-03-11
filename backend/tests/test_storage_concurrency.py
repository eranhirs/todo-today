"""Tests for StorageContext thread-safety and atomic write behaviour."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from backend.models import Metadata, Project, Todo, TodoStore
from backend.storage import (
    StorageContext,
    _atomic_write,
    _lock,
    load_metadata,
    load_store,
    save_metadata,
    save_store,
)


class TestAtomicWrite:
    def test_writes_content(self, tmp_path):
        p = tmp_path / "test.json"
        _atomic_write(p, '{"hello": true}')
        assert p.read_text() == '{"hello": true}'

    def test_no_partial_on_error(self, tmp_path):
        p = tmp_path / "test.json"
        _atomic_write(p, "original")

        class Boom(Exception):
            pass

        # Monkeypatch open to fail mid-write
        import builtins
        real_open = builtins.open

        def bad_open(fd, mode="r", **kw):
            if isinstance(fd, int):
                raise Boom("simulated crash")
            return real_open(fd, mode, **kw)

        with pytest.raises(Boom):
            import builtins as b
            old = b.open
            b.open = bad_open
            try:
                _atomic_write(p, "corrupted")
            finally:
                b.open = old

        # Original file should still be intact
        assert p.read_text() == "original"

    def test_replaces_existing(self, tmp_path):
        p = tmp_path / "test.json"
        _atomic_write(p, "v1")
        _atomic_write(p, "v2")
        assert p.read_text() == "v2"


class TestLoadSaveRoundTrip:
    def test_empty_store_defaults(self):
        store = load_store()
        assert store.projects == []
        assert store.todos == []

    def test_roundtrip_store(self):
        proj = Project(id="proj_x", name="X")
        todo = Todo(id="todo_x", project_id="proj_x", text="Do X")
        store = TodoStore(projects=[proj], todos=[todo])
        save_store(store)
        loaded = load_store()
        assert len(loaded.projects) == 1
        assert loaded.projects[0].id == "proj_x"
        assert len(loaded.todos) == 1
        assert loaded.todos[0].text == "Do X"

    def test_roundtrip_metadata(self):
        meta = Metadata(analysis_model="opus", total_analyses=5)
        save_metadata(meta)
        loaded = load_metadata()
        assert loaded.analysis_model == "opus"
        assert loaded.total_analyses == 5

    def test_corrupt_store_returns_default(self, tmp_path):
        import backend.storage as sm
        (sm.DATA_DIR / "todos.json").write_text("{{{invalid json")
        store = load_store()
        assert store.projects == []

    def test_corrupt_metadata_returns_default(self):
        import backend.storage as sm
        (sm.DATA_DIR / "metadata.json").write_text("{{{bad")
        meta = load_metadata()
        assert meta.total_analyses == 0


class TestStorageContextBasic:
    def test_saves_on_successful_exit(self):
        save_store(TodoStore())
        save_metadata(Metadata())
        with StorageContext() as ctx:
            ctx.store.projects.append(Project(id="proj_t", name="T"))

        loaded = load_store()
        assert any(p.id == "proj_t" for p in loaded.projects)

    def test_does_not_save_on_exception(self):
        save_store(TodoStore())
        save_metadata(Metadata())

        with pytest.raises(ValueError):
            with StorageContext() as ctx:
                ctx.store.projects.append(Project(id="proj_err", name="Err"))
                raise ValueError("boom")

        loaded = load_store()
        assert not any(p.id == "proj_err" for p in loaded.projects)

    def test_read_only_skips_write(self):
        store = TodoStore(projects=[Project(id="proj_ro", name="RO")])
        save_store(store)
        save_metadata(Metadata())

        with StorageContext(read_only=True) as ctx:
            ctx.store.projects.append(Project(id="proj_new", name="NEW"))

        loaded = load_store()
        assert len(loaded.projects) == 1  # mutation not persisted

    def test_read_only_does_not_block(self):
        """Read-only contexts should not acquire the lock."""
        save_store(TodoStore())
        save_metadata(Metadata())

        # Acquire the lock manually
        _lock.acquire()
        try:
            # read_only should still work
            with StorageContext(read_only=True) as ctx:
                _ = ctx.store.todos
        finally:
            _lock.release()


class TestStorageContextConcurrency:
    def test_concurrent_writes_are_serialized(self):
        """Two threads writing simultaneously should not lose data."""
        save_store(TodoStore())
        save_metadata(Metadata())

        results = []
        barrier = threading.Barrier(2, timeout=5)

        def writer(name: str):
            barrier.wait()
            with StorageContext() as ctx:
                ctx.store.projects.append(Project(id=f"proj_{name}", name=name))
            results.append(name)

        t1 = threading.Thread(target=writer, args=("A",))
        t2 = threading.Thread(target=writer, args=("B",))
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        loaded = load_store()
        names = {p.name for p in loaded.projects}
        assert "A" in names
        assert "B" in names

    def test_read_while_writing(self):
        """A reader should see a consistent snapshot even if a writer is active."""
        save_store(TodoStore(projects=[Project(id="proj_init", name="Init")]))
        save_metadata(Metadata())

        read_result = []
        writer_started = threading.Event()
        reader_done = threading.Event()

        def slow_writer():
            with StorageContext() as ctx:
                writer_started.set()
                ctx.store.projects.append(Project(id="proj_new", name="New"))
                # Hold the lock briefly
                reader_done.wait(timeout=5)

        def reader():
            writer_started.wait(timeout=5)
            # Read-only should not block
            with StorageContext(read_only=True) as ctx:
                read_result.append(len(ctx.store.projects))
            reader_done.set()

        tw = threading.Thread(target=slow_writer)
        tr = threading.Thread(target=reader)
        tw.start()
        tr.start()
        tw.join(timeout=10)
        tr.join(timeout=10)

        # Reader should see a consistent state (1 project — the original)
        assert read_result == [1]

    def test_lock_released_after_exception(self):
        """Lock must be released even if __exit__ is triggered by an exception."""
        save_store(TodoStore())
        save_metadata(Metadata())

        with pytest.raises(RuntimeError):
            with StorageContext() as ctx:
                raise RuntimeError("oops")

        # Lock should be free — acquiring should succeed immediately
        acquired = _lock.acquire(timeout=1)
        assert acquired
        _lock.release()

    def test_many_concurrent_increments(self):
        """Stress test: many threads each append a project. All should persist."""
        save_store(TodoStore())
        save_metadata(Metadata())

        n = 10
        barrier = threading.Barrier(n, timeout=10)

        def adder(i: int):
            barrier.wait()
            with StorageContext() as ctx:
                ctx.store.projects.append(Project(id=f"proj_{i}", name=f"P{i}"))

        threads = [threading.Thread(target=adder, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)

        loaded = load_store()
        assert len(loaded.projects) == n
