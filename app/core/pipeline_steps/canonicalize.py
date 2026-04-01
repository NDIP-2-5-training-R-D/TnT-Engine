from app.core.canonicalizer import canonicalize, canonicalize_dict


class Canonicalize:
    name = "canonicalize"

    async def run(self, value, context: dict) -> str:
        if isinstance(value, dict):
            return canonicalize_dict(value)
        return canonicalize(str(value))
