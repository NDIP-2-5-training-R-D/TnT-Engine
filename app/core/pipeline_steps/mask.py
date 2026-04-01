import re


class MaskStep:
    name = "mask"

    async def run(self, value, context: dict) -> str:
        value_str = str(value)
        masking_char = context.get("masking_character", "X")
        pattern = context.get("pattern")

        if pattern:
            # Replace capture groups with masking chars
            def _replace(m: re.Match) -> str:
                return masking_char * len(m.group(0))
            return re.sub(pattern, _replace, value_str)

        # Default: keep first 4 and last 4, mask the middle
        if len(value_str) <= 8:
            return masking_char * len(value_str)
        keep = 4
        masked_len = len(value_str) - keep * 2
        return value_str[:keep] + masking_char * masked_len + value_str[-keep:]
