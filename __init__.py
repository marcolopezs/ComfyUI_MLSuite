"""ComfyUI_MLSuite - Custom nodes by MLSuite.

Nodes are defined under the `nodes/` package. Each node module exposes its own
NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS, which are aggregated here.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Frontend assets (JavaScript widgets) live in ./web
WEB_DIRECTORY = "./web"


def _register(module):
    NODE_CLASS_MAPPINGS.update(getattr(module, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}))


# --- Node modules are imported here as they are added ---
from .nodes import image_loader
_register(image_loader)


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
