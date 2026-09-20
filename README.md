# ComfyUI_MLSuite

**MLSuite** — a collection of custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

> Interface language: **English** (primary). Spanish translations are provided via `locales/`.

## Nodes

| Node | Category | Description |
|------|----------|-------------|
| **Image Loader** | `MLSuite/image` | Load images with a built-in gallery browser, URL input, upload, manual path and automatic index rotation ✅ |
| _Camera Angle Selector_ | `MLSuite/image` | Pick camera angles with a live 3D preview (planned) |
| _Clothes Prompt (Jinja2)_ | `MLSuite/prompt` | Detect clothing and build prompts with Jinja2 (planned) |
| _Image Compare_ | `MLSuite/image` | Compare images with an A/B slider and batch viewer (planned) |

## Image Loader

Load a single image from any of these sources (priority order):

1. **Image URL** — paste a direct link in `image_url`.
2. **Upload** — pick an uploaded image from ComfyUI's `input` folder.
3. **Gallery** — click **Browse gallery**, navigate folders (with cover thumbnails), sort by name/date, adjust thumbnail size, preview on the right panel and select.
4. **Index rotation** — leave everything empty and it walks the base folder recursively, returning the next image on each run (great for datasets).

**Output:** `IMAGE`.

### Base folder resolution

There is **no hardcoded path**. The base folder is resolved as:

1. `manual_path` (if set) — used as-is (paste any absolute folder path).
2. `folder` — one of ComfyUI's standard directories: `input`, `output`, `temp`.
3. Fallback — ComfyUI's `input` directory.

## Installation

### ComfyUI Manager (recommended)
Search for **MLSuite** in the ComfyUI Manager and install.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/marcolopezs/ComfyUI_MLSuite
pip install -r ComfyUI_MLSuite/requirements.txt
```
Then restart ComfyUI.

## License

[MIT](LICENSE) © MLSuite
