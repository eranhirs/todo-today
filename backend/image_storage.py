"""Image storage helpers shared by todo/project routers.

Centralizes the image directory resolution, filename validation, and
on-disk cleanup so both the todo and project endpoints (and any future
callers) treat image files identically.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from .storage import DATA_DIR, load_metadata

# Image storage: either local (next to todos.json) or ephemeral (/tmp).
_TMP_IMAGE_DIR = Path("/tmp/claude-todos-images")

ALLOWED_IMAGE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
}
MAX_IMAGE_SIZE = 20 * 1024 * 1024  # 20 MB


def get_image_dir() -> Path:
    """Return the image directory based on the local_image_storage setting."""
    try:
        meta = load_metadata()
        if meta.local_image_storage:
            d = DATA_DIR / "images"
            d.mkdir(parents=True, exist_ok=True)
            return d
    except Exception:
        pass
    _TMP_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    return _TMP_IMAGE_DIR


def is_safe_filename(filename: str) -> bool:
    """Return False if ``filename`` contains path-traversal sequences."""
    return "/" not in filename and "\\" not in filename and ".." not in filename


def delete_image_files(filenames: Iterable[str]) -> None:
    """Best-effort delete of image files from the configured image dir."""
    image_dir = get_image_dir()
    for fname in filenames:
        fp = image_dir / fname
        if fp.exists():
            fp.unlink(missing_ok=True)


def format_image_suffix(n_or_images) -> str:
    """Render the `[+N image(s)]` suffix used in run_output annotations.

    Accepts either an integer count or any sized iterable.
    Returns an empty string when there are no images, so callers can
    unconditionally append it.
    """
    n = n_or_images if isinstance(n_or_images, int) else len(n_or_images)
    if not n:
        return ""
    return f" [+{n} image{'s' if n != 1 else ''}]"
