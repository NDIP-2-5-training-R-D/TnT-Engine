import pytest
import pytest_asyncio
from unittest.mock import AsyncMock

from app.core.orchestrator import Orchestrator
from app.models.responses import ProcessResponse


@pytest.fixture
def mock_policy_loader():
    loader = AsyncMock()
    loader.get_pipeline.return_value = {
        "role": "test-role",
        "fields": {
            "card_number": ["canonicalize", "hmac", "tokenize"],
            "name": ["canonicalize", "mask"],
        },
    }
    return loader


@pytest.fixture
def orchestrator(mock_policy_loader):
    return Orchestrator(mock_policy_loader)


@pytest.mark.asyncio
async def test_process_success(orchestrator):
    fields = [
        {"name": "card_number", "value": "4111111111111111", "transformation": "token-cc"},
        {"name": "name", "value": "  John Doe  ", "transformation": None},
    ]
    result = await orchestrator.process("test-role", fields)

    assert isinstance(result, ProcessResponse)
    assert result.status in ("success", "partial")
    assert "card_number" in result.results
    assert "name" in result.results
    assert result.results["card_number"].original == "4111111111111111"
    assert result.results["name"].original == "  John Doe  "


@pytest.mark.asyncio
async def test_process_unknown_role(orchestrator, mock_policy_loader):
    mock_policy_loader.get_pipeline.return_value = None
    result = await orchestrator.process("nonexistent-role", [{"name": "x", "value": "y"}])
    assert result.status == "error"
    assert any("No pipeline config" in e for e in result.errors)


@pytest.mark.asyncio
async def test_process_unknown_step(orchestrator, mock_policy_loader):
    mock_policy_loader.get_pipeline.return_value = {
        "role": "test-role",
        "fields": {"field1": ["nonexistent_step"]},
    }
    result = await orchestrator.process("test-role", [{"name": "field1", "value": "val"}])
    assert result.status in ("partial", "error")
    assert result.results["field1"].errors


@pytest.mark.asyncio
async def test_canonicalize_step_applied(orchestrator):
    fields = [{"name": "name", "value": "  Alice  ", "transformation": None}]
    result = await orchestrator.process("test-role", fields)
    name_result = result.results["name"]
    assert "canonicalize" in name_result.steps_applied
    # canonicalize strips whitespace
    assert name_result.result != "  Alice  "
