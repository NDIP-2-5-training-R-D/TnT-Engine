"""Shared pytest configuration and fixtures."""
import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--run-integration",
        action="store_true",
        default=False,
        help="Run integration tests that require a running docker-compose stack",
    )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    if config.getoption("--run-integration"):
        return
    skip_integration = pytest.mark.skip(
        reason="Need --run-integration flag and a running docker-compose stack"
    )
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip_integration)
