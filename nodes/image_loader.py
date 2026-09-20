"""Image Loader (with gallery browser) — MLSuite.

Loads an image from any of these sources, in priority order:
  1. A direct image URL.
  2. An image uploaded to ComfyUI's input folder.
  3. A file picked from the built-in gallery browser.
  4. Automatic index rotation over a folder (recursive walk).

The base folder is resolved without any hardcoded path:
  * ``manual_path``  -> used as-is if provided.
  * ``folder``       -> one of ComfyUI's standard dirs (input / output / temp).
  * fallback         -> ComfyUI's ``input`` directory.
"""

import os
import io
import re
import sys
import random
import socket
import hashlib
import logging
import tempfile
import ipaddress
import subprocess
import unicodedata
from shutil import which
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import numpy as np
import torch
from PIL import Image, ImageOps
import folder_paths

from server import PromptServer
from aiohttp import web

logger = logging.getLogger("MLSuite.ImageLoader")


# --------------------------------------------------------------------------- #
# Constants / paths
# --------------------------------------------------------------------------- #

SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.gif'}

try:
    import pillow_jxl  # noqa: F401
    SUPPORTED_EXTENSIONS.add('.jxl')
except Exception:
    # ImportError (not installed) or OSError (libjxl missing) — JXL is optional.
    pass

SORT_METHODS = [
    "Alphabetical (ASC)",
    "Alphabetical (DESC)",
    "Numerical (ASC)",
    "Numerical (DESC)",
    "Datetime (ASC)",
    "Datetime (DESC)",
    "Random",
]

# Maximum bytes to download from a remote URL (guards against memory DoS).
_MAX_DOWNLOAD = 64 * 1024 * 1024  # 64 MB

# Package root (parent of the "nodes" folder).
_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _init_thumb_cache():
    """Pick a writable thumbnail-cache dir. Falls back gracefully to None.

    Prefers ComfyUI's ``temp`` dir (cleared on restart, so cached thumbnails of
    the user's images never pile up inside the publishable package). Falls back
    to the OS temp dir, then to the package dir. Guarded so a read-only install
    (Docker, system-wide) never crashes the node at import time.
    """
    candidates = []
    try:
        candidates.append(os.path.join(folder_paths.get_temp_directory(), "mlsuite_thumb_cache"))
    except Exception:
        pass
    candidates.append(os.path.join(tempfile.gettempdir(), "mlsuite_thumb_cache"))
    candidates.append(os.path.join(_PKG_DIR, ".thumb_cache"))
    for path in candidates:
        try:
            os.makedirs(path, exist_ok=True)
            return path
        except OSError:
            continue
    return None


_THUMB_CACHE_DIR = _init_thumb_cache()

# Directories whose images have been listed in the gallery. Used as an allow-list
# so the file-serving endpoints only serve images the user actually browsed.
# Insertion-ordered dict used as a bounded set (evicts oldest past the cap).
_ALLOWED_DIRS = {}
_MAX_ALLOWED_DIRS = 1000

# ComfyUI's standard folders, resolved lazily (they can be relocated at runtime).
_COMFY_DIRS = {
    "input": folder_paths.get_input_directory,
    "output": folder_paths.get_output_directory,
    "temp": folder_paths.get_temp_directory,
}


def _comfy_dir_paths():
    """Normalized paths of ComfyUI's standard folders (for the allow-list)."""
    paths = set()
    for getter in _COMFY_DIRS.values():
        try:
            paths.add(_norm(getter()))
        except OSError:
            pass
    return paths


# --------------------------------------------------------------------------- #
# Path helpers (cross-platform, case/Unicode safe)
# --------------------------------------------------------------------------- #

def _clean_path(path):
    # Windows "Copy as path" wraps the path in quotes; also normalize spaces
    # and single quotes.
    if not path:
        return ""
    return path.strip().strip('"').strip("'").strip()


def _norm(path):
    """Canonical form for comparing paths across platforms.

    Resolves symlinks/.. (realpath), unifies Unicode form (NFC — matters on
    macOS/APFS) and case (normcase — matters on Windows/macOS). No-op for case
    on Linux, so it stays correct on case-sensitive filesystems.
    """
    return os.path.normcase(unicodedata.normalize("NFC", os.path.realpath(path)))


def _within(base, target):
    """True if `target` is inside (or equal to) `base`. Handles drive roots
    (C:\\) and cross-drive comparisons robustly via commonpath."""
    try:
        b = _norm(base)
        t = _norm(target)
    except OSError:
        return False
    if b == t:
        return True
    try:
        return os.path.commonpath([b, t]) == b
    except ValueError:
        # Different drives (Windows) or mixed absolute/relative -> not contained.
        return False


def _remember_dir(directory):
    """Add a browsed directory to the bounded allow-list."""
    key = _norm(directory)
    _ALLOWED_DIRS.pop(key, None)
    _ALLOWED_DIRS[key] = None
    while len(_ALLOWED_DIRS) > _MAX_ALLOWED_DIRS:
        _ALLOWED_DIRS.pop(next(iter(_ALLOWED_DIRS)))


def _allowed_roots():
    return list(_ALLOWED_DIRS.keys()) + list(_comfy_dir_paths())


def _resolve_file(path):
    """Return the real path if `path` is an existing file inside an allowed
    directory, else None. Does not distinguish 'missing' from 'not allowed'
    (so error responses don't leak which one it is)."""
    if not path:
        return None
    real = os.path.realpath(path)
    if not os.path.isfile(real):
        return None
    for root in _allowed_roots():
        if _within(root, real):
            return real
    return None


def _resolve_base(folder, manual_path):
    """Resolve the base directory for a given (folder, manual_path) pair.

    `manual_path` is intentionally flexible (any absolute path the user pastes),
    matching how most ComfyUI loaders behave. The file-serving endpoints still
    gate every request through the allow-list.
    """
    manual = _clean_path(manual_path)
    if manual:
        return manual
    getter = _COMFY_DIRS.get(folder)
    if getter:
        return getter()
    return folder_paths.get_input_directory()


def _extract_first_number(s):
    match = re.search(r'\d+', s)
    return int(match.group()) if match else float('inf')


def _is_image(name):
    return os.path.splitext(name)[1].lower() in SUPPORTED_EXTENSIONS


def _sort_files(files, method):
    if method == "Alphabetical (ASC)":
        return sorted(files)
    elif method == "Alphabetical (DESC)":
        return sorted(files, reverse=True)
    elif method == "Numerical (ASC)":
        return sorted(files, key=lambda p: _extract_first_number(os.path.basename(p)))
    elif method == "Numerical (DESC)":
        return sorted(files, key=lambda p: _extract_first_number(os.path.basename(p)), reverse=True)
    elif method == "Datetime (ASC)":
        return sorted(files, key=lambda p: os.path.getmtime(p))
    elif method == "Datetime (DESC)":
        return sorted(files, key=lambda p: os.path.getmtime(p), reverse=True)
    elif method == "Random":
        files = sorted(files)
        random.shuffle(files)
        return files
    return files


# --------------------------------------------------------------------------- #
# Image loading
# --------------------------------------------------------------------------- #

def _to_tensor(pil_image):
    image = pil_image.convert("RGB")
    arr = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _load_single_image(image_path):
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img)
        return _to_tensor(img)


def _validate_url(url):
    """Reject non-http(s) schemes and hosts that resolve to internal addresses
    (blocks file://, SSRF to localhost / cloud metadata / private ranges)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Only http/https URLs are allowed")
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid URL")
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror:
        raise ValueError("Could not resolve URL host")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError("URL points to a non-public address")


def _load_image_from_url(url):
    """Download an image from a URL and convert it to a ComfyUI tensor."""
    _validate_url(url)
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as resp:
        content = resp.read(_MAX_DOWNLOAD + 1)
    if len(content) > _MAX_DOWNLOAD:
        raise ValueError("Image exceeds the maximum allowed size (64 MB)")
    with Image.open(io.BytesIO(content)) as img:
        img = ImageOps.exif_transpose(img)
        return _to_tensor(img)


def _list_input_images():
    input_dir = folder_paths.get_input_directory()
    files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
    files = folder_paths.filter_files_content_types(files, ["image"])
    return sorted(files)


# --------------------------------------------------------------------------- #
# Node
# --------------------------------------------------------------------------- #

class MLSuite_ImageLoader:
    """Load images with a built-in gallery browser, URL input, upload,
    manual path and automatic index rotation over a folder."""

    # Per (directory|sort) rotation counter. Bounded to avoid unbounded growth.
    # ComfyUI executes prompts sequentially, so plain dict access is safe here.
    _counters = {}
    _MAX_COUNTERS = 512

    @classmethod
    def INPUT_TYPES(cls):
        folder_list = list(_COMFY_DIRS.keys())
        image_list = ["(none)"] + _list_input_images()
        return {
            "required": {
                "image": (image_list, {"image_upload": True}),
                "folder": (folder_list,),
                "start_index": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "step": 1}),
                "sort_method": (SORT_METHODS,),
            },
            "optional": {
                "image_url": ("STRING", {"default": ""}),
                "manual_path": ("STRING", {"default": ""}),
                "selected_image": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_NODE = True
    FUNCTION = "load_image"
    CATEGORY = "MLSuite/image"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-run: required so the index rotation advances on every run.
        # (NaN != NaN, so ComfyUI never treats the result as cached.)
        return float("NaN")

    @classmethod
    def VALIDATE_INPUTS(cls, image="(none)", **kwargs):
        if image != "(none)" and not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True

    def load_image(self, folder, start_index, sort_method, manual_path="", image="(none)",
                   selected_image="", image_url=""):
        # 0) Direct URL.
        url = _clean_path(image_url)
        if url:
            try:
                img_tensor = _load_image_from_url(url)
            except Exception as e:
                raise RuntimeError(f"Could not load image from URL: {e}")
            logger.info("Image from URL: %s", url)
            return {"ui": {"next_index": [0]}, "result": (img_tensor,)}

        # 1) Uploaded image (ComfyUI input folder).
        if image != "(none)":
            image_path = folder_paths.get_annotated_filepath(image)
            return {"ui": {"next_index": [0]}, "result": (_load_single_image(image_path),)}

        directory = _resolve_base(folder, manual_path)

        # 2) Manual selection from the gallery: load the chosen image directly.
        # The folder is NOT scanned (it could hold thousands of images).
        selected = _clean_path(selected_image)
        if selected and os.path.isfile(selected):
            logger.info("Manual selection: %s", os.path.basename(selected))
            return {"ui": {"next_index": [0]}, "result": (_load_single_image(selected),)}

        # 3) Automatic index rotation over the folder (recursive).
        if not os.path.isdir(directory):
            raise FileNotFoundError(f"Directory '{directory}' cannot be found.")
        if not os.access(directory, os.R_OK | os.X_OK):
            raise PermissionError(f"No permission to read directory '{directory}'.")

        image_files = [
            os.path.join(root, f)
            for root, _, files in os.walk(directory)
            for f in files if _is_image(f)
        ]

        if not image_files:
            raise FileNotFoundError(f"No images found in '{directory}'.")

        image_files = _sort_files(image_files, sort_method)
        total = len(image_files)

        if sort_method == "Random":
            index = start_index % total
            next_index = start_index
        else:
            key = f"{directory}|{sort_method}"
            data = MLSuite_ImageLoader._counters.get(key)
            # If the incoming start_index does not match what the counter emitted
            # on the previous run, the user changed it manually, so restart there.
            if not data or data["expected"] != start_index:
                current = start_index
            else:
                current = data["current"]
            index = current % total
            next_index = current + 1
            counters = MLSuite_ImageLoader._counters
            counters[key] = {"expected": next_index, "current": next_index}
            if len(counters) > MLSuite_ImageLoader._MAX_COUNTERS:
                counters.pop(next(iter(counters)))

        image_path = image_files[index]
        logger.info("Image %d/%d: %s", index + 1, total, os.path.basename(image_path))

        return {"ui": {"next_index": [next_index]}, "result": (_load_single_image(image_path),)}


# --------------------------------------------------------------------------- #
# Backend routes (self-contained for this node)
# --------------------------------------------------------------------------- #

def _first_image(directory, max_depth=4):
    """Return the path of the first image inside a folder (used as its cover).
    Limits depth so huge trees are not fully walked."""
    try:
        base = directory.rstrip(os.sep)
        base_depth = base.count(os.sep)
        for root, dirs, files in os.walk(base):
            if root.count(os.sep) - base_depth > max_depth:
                dirs[:] = []
                continue
            dirs.sort()
            for f in sorted(files):
                if _is_image(f):
                    return os.path.join(root, f)
    except Exception:
        logger.debug("cover scan failed for %s", directory, exc_info=True)
    return None


def _thumb_response(source_path, size, headers):
    """Build (and cache, if possible) a JPEG thumbnail response for an image."""
    cache_path = None
    if _THUMB_CACHE_DIR:
        try:
            st = os.stat(source_path)
            key = hashlib.sha1(
                f"{os.path.normcase(source_path)}|{int(st.st_mtime)}|{st.st_size}|{size}".encode("utf-8")
            ).hexdigest()
            cache_path = os.path.join(_THUMB_CACHE_DIR, key + ".jpg")
            if os.path.isfile(cache_path):
                with open(cache_path, "rb") as fh:
                    return web.Response(body=fh.read(), content_type="image/jpeg", headers=headers)
        except OSError:
            cache_path = None

    with Image.open(source_path) as img:
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        img.thumbnail((size, size))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
    data = buf.getvalue()

    if cache_path:
        try:
            with open(cache_path, "wb") as fh:
                fh.write(data)
        except OSError:
            pass
    return web.Response(body=data, content_type="image/jpeg", headers=headers)


def _query_int(request, name, default):
    try:
        return int(request.query.get(name, str(default)))
    except (TypeError, ValueError):
        return default


@PromptServer.instance.routes.post("/mlsuite/image-loader/navigate")
async def _navigate_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"status": "error", "message": "Invalid request"}, status=400)

    folder = data.get("folder", "")
    manual_path = data.get("manual_path", "")
    sort_method = data.get("sort_method", "Alphabetical (ASC)")
    subpath = data.get("subpath", "") or ""

    base_real = os.path.realpath(_resolve_base(folder, manual_path))
    if not os.path.isdir(base_real):
        logger.warning("navigate: base not found: %s", base_real)
        return web.json_response({"status": "error", "message": "Folder not found"}, status=404)

    # Security: never leave the base directory.
    current = os.path.realpath(os.path.join(base_real, subpath))
    if not _within(base_real, current):
        current = base_real
    if not os.path.isdir(current):
        return web.json_response({"status": "error", "message": "Folder not found"}, status=404)

    _remember_dir(current)

    folders = []
    image_files = []
    try:
        for entry in os.scandir(current):
            if entry.is_dir():
                folders.append(entry.name)
            elif entry.is_file() and _is_image(entry.name):
                image_files.append(entry.path)
    except OSError:
        logger.warning("navigate: cannot scan %s", current, exc_info=True)

    folders.sort(key=lambda s: s.lower())
    if sort_method == "Random":
        image_files = sorted(image_files)
    else:
        image_files = _sort_files(image_files, sort_method)

    rel = os.path.relpath(current, base_real)
    if rel == ".":
        rel = ""

    folder_items = [
        {"name": name, "rel": (name if not rel else rel + os.sep + name)}
        for name in folders
    ]

    def _mtime(p):
        try:
            return os.path.getmtime(p)
        except OSError:
            return 0

    image_items = [
        {"index": i, "path": p, "name": os.path.basename(p), "mtime": _mtime(p)}
        for i, p in enumerate(image_files)
    ]

    return web.json_response({
        "status": "ok",
        "rel": rel,
        "folders": folder_items,
        "images": image_items,
        "total_images": len(image_items),
    })


@PromptServer.instance.routes.get("/mlsuite/image-loader/thumbnail")
async def _thumbnail_handler(request):
    real = _resolve_file(request.query.get("path", ""))
    if real is None:
        return web.Response(status=404, text="not found")

    size = _query_int(request, "size", 220)
    headers = {"Cache-Control": "max-age=86400"}
    try:
        return _thumb_response(real, size, headers)
    except Exception:
        logger.warning("thumbnail failed for %s", real, exc_info=True)
        return web.Response(status=500, text="thumbnail error")


@PromptServer.instance.routes.get("/mlsuite/image-loader/raw")
async def _raw_handler(request):
    """Serve the original image file (used for the in-node preview)."""
    real = _resolve_file(request.query.get("path", ""))
    if real is None:
        return web.Response(status=404, text="not found")
    # FileResponse streams the file and sets Content-Type automatically.
    return web.FileResponse(real, headers={"Cache-Control": "max-age=3600"})


@PromptServer.instance.routes.get("/mlsuite/image-loader/locate")
async def _locate_handler(request):
    """Return the subpath (relative to the base dir) of the folder that contains
    the selected image, so the gallery can open directly there."""
    folder = request.query.get("folder", "")
    manual_path = request.query.get("manual_path", "")
    image = _clean_path(request.query.get("image", ""))

    base_real = os.path.realpath(_resolve_base(folder, manual_path))
    if not image or not os.path.isfile(image):
        return web.json_response({"status": "not_found", "rel": ""})

    image_dir = os.path.dirname(os.path.realpath(image))
    if not _within(base_real, image_dir):
        return web.json_response({"status": "outside", "rel": ""})

    rel = os.path.relpath(image_dir, base_real)
    if rel == ".":
        rel = ""
    return web.json_response({"status": "ok", "rel": rel.replace(os.sep, "/")})


@PromptServer.instance.routes.get("/mlsuite/image-loader/cover")
async def _cover_handler(request):
    """Cover thumbnail for a folder (its first image)."""
    folder = request.query.get("folder", "")
    manual_path = request.query.get("manual_path", "")
    subpath = request.query.get("subpath", "") or ""

    base_real = os.path.realpath(_resolve_base(folder, manual_path))
    current = os.path.realpath(os.path.join(base_real, subpath))
    if not _within(base_real, current):
        return web.Response(status=404, text="not found")
    if not os.path.isdir(current):
        return web.Response(status=404, text="not found")

    cover = _first_image(current)
    if not cover or not os.path.isfile(cover):
        return web.Response(status=404, text="no images")

    _remember_dir(current)
    size = _query_int(request, "size", 180)
    headers = {"Cache-Control": "max-age=86400"}
    try:
        return _thumb_response(cover, size, headers)
    except Exception:
        logger.warning("cover failed for %s", cover, exc_info=True)
        return web.Response(status=500, text="cover error")


@PromptServer.instance.routes.post("/mlsuite/image-loader/open-folder")
async def _open_folder_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"status": "error", "message": "Invalid request"}, status=400)

    directory = _resolve_base(data.get("folder", ""), data.get("manual_path", ""))
    if not os.path.isdir(directory):
        return web.json_response({"status": "error", "message": "Folder not found"}, status=200)

    try:
        if sys.platform == "win32":
            os.startfile(directory)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", directory])
        else:
            if not which("xdg-open"):
                return web.json_response({
                    "status": "error",
                    "message": "Cannot open the folder here (no desktop/xdg-open). "
                               "This usually means ComfyUI runs on a headless server.",
                }, status=200)
            subprocess.Popen(["xdg-open", directory])
    except Exception:
        logger.warning("open-folder failed", exc_info=True)
        return web.json_response({"status": "error", "message": "Could not open the folder"}, status=200)

    return web.json_response({"status": "ok"})


NODE_CLASS_MAPPINGS = {
    "MLSuite_ImageLoader": MLSuite_ImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MLSuite_ImageLoader": "Image Loader",
}
