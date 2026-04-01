import asyncio
import logging

from fastapi import APIRouter, Depends

from app.api.dependencies import verify_vault_token, get_orchestrator
from app.core.orchestrator import Orchestrator
from app.models.requests import ProcessRequest, BatchProcessRequest
from app.models.responses import ProcessResponse, BatchProcessResponse, BatchItemResult

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(verify_vault_token)])


@router.post("/process", response_model=ProcessResponse)
async def process(body: ProcessRequest, orchestrator: Orchestrator = Depends(get_orchestrator)):
    fields = [f.model_dump() for f in body.fields]
    return await orchestrator.process(body.role, fields)


@router.post("/process/batch", response_model=BatchProcessResponse)
async def process_batch(body: BatchProcessRequest, orchestrator: Orchestrator = Depends(get_orchestrator)):
    async def _process_one(item: ProcessRequest) -> BatchItemResult:
        fields = [f.model_dump() for f in item.fields]
        result = await orchestrator.process(item.role, fields)
        return BatchItemResult(
            role=item.role,
            status=result.status,
            results=result.results,
            errors=result.errors,
        )

    tasks = [_process_one(item) for item in body.items]
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    results: list[BatchItemResult] = []
    errors: list[str] = []
    succeeded = 0
    failed = 0

    for i, outcome in enumerate(outcomes):
        if isinstance(outcome, Exception):
            logger.error("Batch item %d failed with exception: %s", i, outcome, exc_info=outcome)
            errors.append(f"Item {i}: {outcome}")
            failed += 1
            results.append(BatchItemResult(role=body.items[i].role, status="error", errors=[str(outcome)]))
        else:
            results.append(outcome)
            if outcome.status == "error":
                failed += 1
            else:
                succeeded += 1

    total = len(body.items)
    if failed == 0:
        status = "success"
    elif succeeded == 0:
        status = "error"
    else:
        status = "partial"

    return BatchProcessResponse(
        status=status,
        total=total,
        succeeded=succeeded,
        failed=failed,
        results=results,
        errors=errors,
    )
