"""Frozen entry point for the desktop app's local PDF engine.

Keep this tiny. The real protocol remains ``workpaper_engine.cli`` so dev,
MCP, tests, and the packaged executable all exercise the same implementation.
"""

from workpaper_engine.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
