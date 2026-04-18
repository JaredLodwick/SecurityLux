"""Module entry point — enables ``python -m doorcam``."""

from .server import run_from_env


if __name__ == "__main__":
    run_from_env()
