"""Module entry point — enables ``python -m camera_node``."""

from .publisher import run_from_env


if __name__ == "__main__":
    run_from_env()
