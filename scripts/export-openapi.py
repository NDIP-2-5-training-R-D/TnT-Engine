#!/usr/bin/env python3
"""Export the T&T Engine OpenAPI specification to a YAML file.

Usage:
    python scripts/export-openapi.py
    # Writes to docs/openapi.yaml

This enables:
  - SDK code generation (openapi-generator, autorest)
  - API documentation hosting (Swagger UI, Redoc)
  - Contract testing between services
"""

import json
import sys
from pathlib import Path

import yaml

# Add src to path so we can import the app
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from tnt_engine.main import create_app


def export_openapi() -> None:
    app = create_app()
    schema = app.openapi()

    output_dir = Path(__file__).resolve().parent.parent / "docs"
    output_dir.mkdir(exist_ok=True)

    # YAML version (human-readable)
    yaml_path = output_dir / "openapi.yaml"
    with open(yaml_path, "w") as f:
        yaml.dump(schema, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
    print(f"OpenAPI spec (YAML) written to: {yaml_path}")

    # JSON version (for code generators)
    json_path = output_dir / "openapi.json"
    with open(json_path, "w") as f:
        json.dump(schema, f, indent=2)
    print(f"OpenAPI spec (JSON) written to: {json_path}")


if __name__ == "__main__":
    export_openapi()
