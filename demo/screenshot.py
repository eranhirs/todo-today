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

# Smaller viewport = larger text relative to image size (zoomed-in feel)
# Height is generous so an expanded todo (output + follow-up bar) AND a few
# other todos all fit without scrolling past the project header.
VIEWPORT = {"width": 1100, "height": 1000}

# Time to let the app render and settle (polls, animations)
SETTLE_SECONDS = 5


def take_screenshot(port: int, output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport=VIEWPORT, device_scale_factor=2)

        # Navigate to a specific project page (cleaner than all-projects view)
        url = f"http://localhost:{port}?project=proj_claude_todos"
        print(f"Loading {url} ...")
        page.goto(url, wait_until="load", timeout=60000)

        # Let polling and animations settle
        time.sleep(SETTLE_SECONDS)

        paths = []

        # Minimize sidebar for the main screenshot (cleaner look)
        collapse_btn = page.locator(".sidebar-collapse-btn").first
        if collapse_btn.count() > 0:
            collapse_btn.click()
            time.sleep(0.5)

        # Expand the showcase todo so its run output and follow-up bar are visible.
        # This communicates that you can talk to Claude from the todo interface.
        showcase = page.locator("[data-todo-id='todo_demo_06'] .todo-text").first
        if showcase.count() > 0:
            showcase.click()
            time.sleep(0.8)

        # Full-page screenshot (sidebar minimized)
        png_path = output_dir / "screenshot.png"
        page.screenshot(path=str(png_path), full_page=False)
        paths.append(png_path)
        print(f"  Saved {png_path}")

        # Collapse the showcase todo before continuing so it doesn't affect the
        # autopilot screenshot below.
        if showcase.count() > 0:
            showcase.click()
            time.sleep(0.3)

        # Expand sidebar back for the autopilot screenshot
        if collapse_btn.count() > 0:
            collapse_btn.click()
            time.sleep(0.5)

        # Autopilot detail — crop to the project list area
        project_list = page.locator(".project-list").first
        if project_list.count() > 0:
            autopilot_path = output_dir / "autopilot.png"
            project_list.screenshot(path=str(autopilot_path))
            paths.append(autopilot_path)
            print(f"  Saved {autopilot_path}")

        # Dashboard view screenshot — wider viewport so content is readable
        DASHBOARD_VIEWPORT = {"width": 1400, "height": 900}
        dash_page = browser.new_page(viewport=DASHBOARD_VIEWPORT, device_scale_factor=2)
        dashboard_url = f"{url}&view=dashboard"
        print(f"Loading dashboard: {dashboard_url} ...")
        dash_page.goto(dashboard_url, wait_until="load", timeout=60000)
        time.sleep(SETTLE_SECONDS)

        # Collapse sidebar for cleaner dashboard screenshot
        dash_collapse_btn = dash_page.locator(".sidebar-collapse-btn").first
        if dash_collapse_btn.count() > 0:
            dash_collapse_btn.click()
            time.sleep(0.5)

        # Crop to the dashboard element to avoid empty space
        dashboard_el = dash_page.locator(".dashboard").first
        dashboard_path = output_dir / "dashboard.png"
        dashboard_el.screenshot(path=str(dashboard_path))
        paths.append(dashboard_path)
        print(f"  Saved {dashboard_path}")
        dash_page.close()

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
