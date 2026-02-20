"""
SwarmX Logging — Consistent, rich logging setup.

Provides structured logging with color support via Rich.
"""

from __future__ import annotations

import logging
import sys


def setup_logging(
    level: str = "INFO",
    show_time: bool = True,
    rich_output: bool = True,
) -> None:
    """
    Configure SwarmX logging.

    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR).
        show_time: Whether to show timestamps.
        rich_output: Whether to use Rich for colored output.
    """
    log_level = getattr(logging, level.upper(), logging.INFO)

    if rich_output:
        try:
            from rich.logging import RichHandler

            handler = RichHandler(
                level=log_level,
                show_time=show_time,
                show_path=False,
                markup=True,
                rich_tracebacks=True,
            )
            fmt = "%(message)s"
        except ImportError:
            handler = logging.StreamHandler(sys.stderr)
            fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    else:
        handler = logging.StreamHandler(sys.stderr)
        fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"

    handler.setFormatter(logging.Formatter(fmt))

    # Configure root swarmx logger
    swarmx_logger = logging.getLogger("swarmx")
    swarmx_logger.setLevel(log_level)
    swarmx_logger.addHandler(handler)
    swarmx_logger.propagate = False
