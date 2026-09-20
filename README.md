# ComfyUI_MLSuite

**MLSuite** is a collection of custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI), built for a smoother image workflow. It starts with a powerful **Image Loader** and will keep growing.

> Interface language: **English** (primary). Spanish translations are included via `locales/`.

<!-- Add a screenshot/GIF of the node and uncomment the line below (save it as assets/screenshot.png):
![Image Loader](assets/screenshot.png)
-->

## Image Loader

One node to bring any image into your workflow — from an **upload**, a **direct URL**, a **visual gallery browser**, or by **automatically rotating** through a folder (perfect for datasets). Every source shows a live in-node preview with the real dimensions.

### Features

- 🖼️ **Four sources in one node** — upload, image URL, gallery pick, or automatic index rotation over a folder.
- 🗂️ **Built-in gallery browser** — navigate folders with cover thumbnails, sort by name/date, adjust thumbnail size, preview on a large panel and select with a click (or double-click).
- 👁️ **Consistent in-node preview** — the same native preview for every source, always fitting the node, with `width × height`.
- 🔁 **Dataset rotation** — leave it empty and it walks the folder recursively, returning the next image on each run.
- 🔒 **Cross-platform & hardened** — case/Unicode-safe paths (Windows/macOS/Linux), URL download protected against `file://`/SSRF, and file serving restricted to a browsed allow-list.
- 🌐 **Bilingual UI** — English by default, Spanish via `locales/`.

### Inputs

| Input | Description |
|-------|-------------|
| `image` | An image uploaded to ComfyUI's `input` folder. `(none)` to skip. |
| `folder` | Base folder: one of ComfyUI's standard dirs — `input`, `output`, `temp`. |
| `start_index` | Starting index for the automatic rotation. |
| `sort_method` | Order used by the rotation (alphabetical / numerical / date / random). |
| `image_url` *(optional)* | A direct image URL. Takes priority over everything. |
| `manual_path` *(optional)* | Any absolute folder path. Takes priority over `folder`. |
| `selected_image` *(optional)* | Path of the image picked in the gallery. |

**Output:** `IMAGE`.

### Base folder resolution

No hardcoded paths. The base folder is resolved as:

1. `manual_path` if set — used as-is (paste any absolute folder path).
2. `folder` — one of ComfyUI's standard directories (`input`, `output`, `temp`).
3. Fallback — ComfyUI's `input` directory.

> [!NOTE]
> `manual_path` accepts any absolute folder so you can load from your own
> directories. Files are always served through an internal allow-list.

## Installation

### ComfyUI Manager (recommended)

Search for **MLSuite** in the ComfyUI Manager and click install, then restart ComfyUI.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/marcolopezs/ComfyUI_MLSuite
pip install -r ComfyUI_MLSuite/requirements.txt
```

Then restart ComfyUI.

## Usage

1. Add the **Image Loader** node (category `MLSuite/image`).
2. Choose a source:
   - **URL** — paste a link into `image_url`.
   - **Upload** — pick a file from the `image` dropdown.
   - **Gallery** — click **Browse gallery**, navigate, and select an image.
   - **Rotation** — leave everything empty and run repeatedly to step through a folder.
3. The chosen image previews inside the node and comes out of the `IMAGE` output.

Extra buttons: **Open folder** (opens the base folder in your file explorer) and **Clear selection**.

## License

[MIT](LICENSE) © MLSuite
