import logging
from typing import Any

from app.core.canonicalizer import canonicalize, canonicalize_dict
from app.core.pipeline_steps import Canonicalize, HMACStep, TokenizeStep, MaskStep
from app.models.responses import FieldResult, ProcessResponse

logger = logging.getLogger(__name__)

# Registry: step name → step class instance
# Add new step classes here — Orchestrator never has if/else per step type
_STEP_REGISTRY: dict[str, Any] = {
    step.name: step()
    for step in [Canonicalize, HMACStep, TokenizeStep, MaskStep]
}


class Orchestrator:
    """
    Dynamic pipeline engine.
    Loads pipeline config from PolicyLoader, runs each step in order.
    On step failure: logs error, continues with previous value, marks status partial.
    """

    def __init__(self, policy_loader):
        self._policy_loader = policy_loader

    async def process(self, role: str, fields: list[dict]) -> ProcessResponse:
        """
        Process a list of {name, value, transformation} dicts under a given role.
        Returns a ProcessResponse.
        """
        pipeline_config = await self._policy_loader.get_pipeline(role)
        if pipeline_config is None:
            return ProcessResponse(
                status="error",
                errors=[f"No pipeline config found for role '{role}'"],
            )

        field_configs: dict[str, list[str]] = pipeline_config.get("fields", {})
        results: dict[str, FieldResult] = {}
        has_error = False

        for field in fields:
            field_name = field["name"]
            original_value = field.get("value")
            transformation = field.get("transformation")

            steps = field_configs.get(field_name, [])
            context = {
                "role": role,
                "field": field_name,
                "transformation": transformation or field_name,
                "key_name": role,
            }

            current_value = original_value
            steps_applied: list[str] = []
            errors: list[str] = []

            for step_name in steps:
                step = _STEP_REGISTRY.get(step_name)
                if step is None:
                    msg = f"Unknown step '{step_name}' for field '{field_name}'"
                    logger.warning(msg)
                    errors.append(msg)
                    has_error = True
                    continue

                try:
                    current_value = await step.run(current_value, context)
                    steps_applied.append(step_name)
                except Exception as exc:
                    msg = f"Step '{step_name}' failed for field '{field_name}': {exc}"
                    logger.error(msg, exc_info=True)
                    errors.append(msg)
                    has_error = True
                    # Continue with current_value unchanged

            results[field_name] = FieldResult(
                original=original_value,
                result=current_value,
                steps_applied=steps_applied,
                errors=errors,
            )

        all_have_errors = all(bool(r.errors) for r in results.values())
        if not results:
            status = "error"
        elif all_have_errors:
            status = "error"
        elif has_error:
            status = "partial"
        else:
            status = "success"

        return ProcessResponse(status=status, results=results)
