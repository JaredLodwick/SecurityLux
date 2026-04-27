"""Module entry point — enables ``python -m doorcam``."""

from .publisher import run_from_env


if __name__ == "__main__":
    run_from_env()
