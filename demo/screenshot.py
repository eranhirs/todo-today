#!/usr/bin/env python3
"""Take a screenshot of the demo instance for docs.

Usage:
    python3 demo/screenshot.py              # uses demo on :5153
    python3 demo/screenshot.py --port 5152  # screenshot the real instance

Requires: pip install playwright && playwright install chromium

Output: docs/images/screenshot.png (and .jpeg for README compat)
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Error: playwright not installed. Run:")
    print("  .venv/bin/pip install playwright && .venv/bin/playwright install chromium")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
IMAGES_DIR = ROOT / "docs" / "images"

# Match the existing screenshot dimensions
VIEWPORT = {"width": 1600, "height": 900}

# Time to let the app render and settle (polls, animations)
SETTLE_SECONDS = 3


def take_screenshot(port: int, output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport=VIEWPORT, device_scale_factor=2)

        url = f"http://localhost:{port}"
        print(f"Loading {url} ...")
        page.goto(url, wait_until="networkidle")

        # Let polling and animations settle
        time.sleep(SETTLE_SECONDS)

        # Expand the first project if collapsed, so todos are visible
        first_project = page.locator(".project-card").first
        if first_project.count() > 0:
            # Click the project header to make sure it's selected/visible
            pass

        paths = []

        # Full-page screenshot (PNG for quality)
        png_path = output_dir / "screenshot.png"
        page.screenshot(path=str(png_path), full_page=False)
        paths.append(png_path)
        print(f"  Saved {png_path}")

        # JPEG version for README (smaller file size)
        jpeg_path = output_dir / "screenshot.jpeg"
        page.screenshot(path=str(jpeg_path), full_page=False, type="jpeg", quality=90)
        paths.append(jpeg_path)
        print(f"  Saved {jpeg_path}")

        # Autopilot detail — crop to the project list area
        project_list = page.locator(".project-list").first
        if project_list.count() > 0:
            autopilot_path = output_dir / "autopilot.png"
            project_list.screenshot(path=str(autopilot_path))
            paths.append(autopilot_path)
            print(f"  Saved {autopilot_path}")

        browser.close()

    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description="Screenshot Claude Todos for docs")
    parser.add_argument("--port", type=int, default=5153, help="Port to screenshot (default: 5153 demo)")
    parser.add_argument("--output", type=str, default=str(IMAGES_DIR), help="Output directory")
    args = parser.parse_args()

    paths = take_screenshot(args.port, Path(args.output))
    print(f"\nDone! {len(paths)} screenshots saved to {args.output}/")


if __name__ == "__main__":
    main()
