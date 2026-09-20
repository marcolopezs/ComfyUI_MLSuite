import { app } from "../../scripts/app.js";

const API = "/mlsuite/image-loader";
const PAGE_SIZE = 120;

function getWidget(node, name) {
    return node.widgets?.find(w => w.name === name);
}

// --------------------------------------------------------------------------- //
// In-node preview — uses ComfyUI's native image preview (node.imgs) for every
// source (upload, URL, gallery), so the node always resizes to fit the image
// and never overflows. The native preview also shows the "width × height" info.
// --------------------------------------------------------------------------- //

function showInNode(node, src) {
    if (!src) {
        node.imgs = null;
        node.setDirtyCanvas(true, true);
        return;
    }
    const img = new Image();
    img.onload = () => {
        node.imgs = [img];
        node.setDirtyCanvas(true, true);
    };
    img.onerror = () => {};
    img.src = src;
}

// Preview a file on disk through the /raw endpoint (serves the full image, so
// the native preview reports the real dimensions).
function previewFromPath(node, path) {
    showInNode(node, path ? `${API}/raw?path=${encodeURIComponent(path)}` : null);
}

// --------------------------------------------------------------------------- //
// Persisted UI preferences
// --------------------------------------------------------------------------- //

const LS = {
    get(k, def) { try { const v = localStorage.getItem("mlsuite.imageloader." + k); return v === null ? def : v; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem("mlsuite.imageloader." + k, v); } catch (e) {} },
};

function sortImages(arr, criterion, asc) {
    const s = [...arr];
    if (criterion === "date") {
        s.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
    } else {
        s.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    }
    if (!asc) s.reverse();
    return s;
}

// --------------------------------------------------------------------------- //
// Gallery browser (fullscreen overlay)
// --------------------------------------------------------------------------- //

function openGallery(node) {
    const folder = getWidget(node, "folder")?.value || "";
    const manual_path = getWidget(node, "manual_path")?.value || "";
    const sort_method = getWidget(node, "sort_method")?.value || "Alphabetical (ASC)";
    const selWidget = getWidget(node, "selected_image");

    let criterion = LS.get("sort", "name");     // "name" | "date"
    let asc = LS.get("dir", "asc") === "asc";
    let thumbSize = parseInt(LS.get("thumb", "150"), 10) || 150;

    // Overlay
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
        position: "fixed", inset: "0", zIndex: "10000",
        background: "rgba(0,0,0,0.8)", display: "flex",
        flexDirection: "column", padding: "20px", boxSizing: "border-box",
    });

    // Top bar
    const bar = document.createElement("div");
    Object.assign(bar.style, {
        display: "flex", alignItems: "center", gap: "12px",
        color: "#eee", marginBottom: "8px", fontFamily: "sans-serif",
    });
    const btnUp = document.createElement("button");
    btnUp.textContent = "⬆ Up";
    Object.assign(btnUp.style, { padding: "6px 10px", cursor: "pointer" });
    const pathLabel = document.createElement("div");
    Object.assign(pathLabel.style, {
        fontSize: "14px", fontWeight: "bold", flex: "1",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    });
    const btnClose = document.createElement("button");
    btnClose.textContent = "Close (Esc)";
    Object.assign(btnClose.style, { padding: "6px 12px", cursor: "pointer" });
    bar.appendChild(btnUp);
    bar.appendChild(pathLabel);
    bar.appendChild(btnClose);

    // Controls bar (sort, size, pagination)
    const ctrlBar = document.createElement("div");
    Object.assign(ctrlBar.style, {
        display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
        color: "#ccc", marginBottom: "10px", fontFamily: "sans-serif", fontSize: "13px",
    });

    function mkLabel(t) {
        const l = document.createElement("span");
        l.textContent = t; l.style.opacity = "0.8";
        return l;
    }
    const selSort = document.createElement("select");
    selSort.innerHTML = `<option value="name">Name</option><option value="date">Date</option>`;
    selSort.value = criterion;
    selSort.style.padding = "3px";
    const selDir = document.createElement("select");
    selDir.innerHTML = `<option value="asc">Ascending</option><option value="desc">Descending</option>`;
    selDir.value = asc ? "asc" : "desc";
    selDir.style.padding = "3px";

    const rangeSize = document.createElement("input");
    rangeSize.type = "range"; rangeSize.min = "90"; rangeSize.max = "320"; rangeSize.step = "10";
    rangeSize.value = String(thumbSize);
    rangeSize.style.verticalAlign = "middle";
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = thumbSize + "px";
    sizeLabel.style.minWidth = "42px";

    const sep = document.createElement("div");
    sep.style.flex = "1";

    const info = document.createElement("div");
    info.style.opacity = "0.85";
    const btnPrev = document.createElement("button");
    btnPrev.textContent = "◀"; btnPrev.title = "Previous page";
    Object.assign(btnPrev.style, { padding: "5px 9px", cursor: "pointer" });
    const pageLabel = document.createElement("span");
    Object.assign(pageLabel.style, { minWidth: "90px", textAlign: "center" });
    const btnNext = document.createElement("button");
    btnNext.textContent = "▶"; btnNext.title = "Next page";
    Object.assign(btnNext.style, { padding: "5px 9px", cursor: "pointer" });
    const jumpInput = document.createElement("input");
    jumpInput.type = "number"; jumpInput.min = "1"; jumpInput.title = "Go to page";
    Object.assign(jumpInput.style, { width: "56px", padding: "4px" });

    ctrlBar.appendChild(mkLabel("Sort:"));
    ctrlBar.appendChild(selSort);
    ctrlBar.appendChild(selDir);
    ctrlBar.appendChild(mkLabel("Size:"));
    ctrlBar.appendChild(rangeSize);
    ctrlBar.appendChild(sizeLabel);
    ctrlBar.appendChild(sep);
    ctrlBar.appendChild(info);
    ctrlBar.appendChild(btnPrev);
    ctrlBar.appendChild(pageLabel);
    ctrlBar.appendChild(btnNext);
    ctrlBar.appendChild(jumpInput);

    // Body: grid (left, scrolls) + large preview (right).
    const body = document.createElement("div");
    Object.assign(body.style, { flex: "1", minHeight: "0", display: "flex", gap: "12px" });

    const scrollArea = document.createElement("div");
    Object.assign(scrollArea.style, {
        flex: "1", minWidth: "0", overflowY: "auto",
        background: "#1e1e1e", padding: "12px", borderRadius: "8px",
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        width: "clamp(320px, 40%, 620px)", display: "flex", flexDirection: "column",
        gap: "8px", background: "#151515", borderRadius: "8px", padding: "10px", boxSizing: "border-box",
    });
    const preWrap = document.createElement("div");
    Object.assign(preWrap.style, {
        flex: "1", minHeight: "0", display: "flex", alignItems: "center",
        justifyContent: "center", overflow: "hidden", background: "#111", borderRadius: "6px",
    });
    const preImg = document.createElement("img");
    Object.assign(preImg.style, { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "none" });
    const prePlaceholder = document.createElement("div");
    prePlaceholder.textContent = "Click an image to preview it here";
    Object.assign(prePlaceholder.style, { color: "#777", fontFamily: "sans-serif", fontSize: "13px", padding: "20px", textAlign: "center" });
    preWrap.appendChild(preImg);
    preWrap.appendChild(prePlaceholder);

    const preName = document.createElement("div");
    Object.assign(preName.style, {
        color: "#ddd", fontFamily: "sans-serif", fontSize: "12px", textAlign: "center",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minHeight: "16px",
    });
    const preNav = document.createElement("div");
    Object.assign(preNav.style, { display: "flex", gap: "8px", justifyContent: "center" });
    const btnPreImgPrev = document.createElement("button");
    btnPreImgPrev.textContent = "◀ Previous";
    Object.assign(btnPreImgPrev.style, { padding: "6px 12px", cursor: "pointer", flex: "1" });
    const btnPreImgNext = document.createElement("button");
    btnPreImgNext.textContent = "Next ▶";
    Object.assign(btnPreImgNext.style, { padding: "6px 12px", cursor: "pointer", flex: "1" });
    preNav.appendChild(btnPreImgPrev);
    preNav.appendChild(btnPreImgNext);
    const btnSelect = document.createElement("button");
    btnSelect.textContent = "✓ Select this image";
    Object.assign(btnSelect.style, {
        padding: "9px 12px", cursor: "pointer", background: "#4aa3ff", color: "#000",
        fontWeight: "bold", border: "none", borderRadius: "6px", fontFamily: "sans-serif",
    });
    btnSelect.disabled = true;

    panel.appendChild(preWrap);
    panel.appendChild(preName);
    panel.appendChild(preNav);
    panel.appendChild(btnSelect);

    body.appendChild(scrollArea);
    body.appendChild(panel);

    overlay.appendChild(bar);
    overlay.appendChild(ctrlBar);
    overlay.appendChild(body);
    document.body.appendChild(overlay);

    const close = () => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
    };
    const onKey = (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowRight") { e.preventDefault(); setFocus(focus + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); setFocus(focus - 1); }
        else if (e.key === "Enter") { if (focus >= 0) selectFocused(); }
    };
    document.addEventListener("keydown", onKey);
    btnClose.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    // Folder navigation via a stack of relative subpaths.
    const stack = [""];
    let folders = [];
    let imagesRaw = [];
    let images = [];
    let page = 0;
    let totalPages = 1;
    let focus = -1;

    function gridStyle(el) {
        Object.assign(el.style, {
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`,
            gap: "10px", alignContent: "start",
        });
    }

    function card(borderColor) {
        const c = document.createElement("div");
        Object.assign(c.style, {
            cursor: "pointer", borderRadius: "6px", overflow: "hidden",
            border: `2px solid ${borderColor || "transparent"}`, background: "#2a2a2a",
            display: "flex", flexDirection: "column",
        });
        return c;
    }

    function selectFocused() {
        if (focus < 0 || focus >= images.length) return;
        const item = images[focus];
        if (selWidget) {
            selWidget.value = item.path;
            previewFromPath(node, item.path);
        }
        close();
    }

    function renderPreview() {
        if (focus < 0 || focus >= images.length) {
            preImg.style.display = "none";
            prePlaceholder.style.display = "block";
            preName.textContent = "";
            btnSelect.disabled = true;
            btnPreImgPrev.disabled = btnPreImgNext.disabled = true;
            return;
        }
        const item = images[focus];
        prePlaceholder.style.display = "none";
        preImg.style.display = "block";
        preImg.src = `${API}/thumbnail?path=${encodeURIComponent(item.path)}&size=1024`;
        preName.textContent = `${focus + 1}/${images.length} — ${item.name}`;
        btnSelect.disabled = false;
        btnPreImgPrev.disabled = focus <= 0;
        btnPreImgNext.disabled = focus >= images.length - 1;
    }

    function setFocus(i) {
        if (!images.length) return;
        focus = Math.max(0, Math.min(images.length - 1, i));
        const targetPage = Math.floor(focus / PAGE_SIZE);
        if (targetPage !== page) { page = targetPage; render(); }
        else { markFocus(); }
        renderPreview();
    }

    function markFocus() {
        scrollArea.querySelectorAll("[data-img-idx]").forEach(el => {
            const idx = parseInt(el.dataset.imgIdx, 10);
            const isFocus = idx === focus;
            const isSel = images[idx]?.path === (selWidget?.value || "");
            el.style.borderColor = isFocus ? "#ffd24a" : (isSel ? "#4aa3ff" : "transparent");
            if (isFocus) el.scrollIntoView({ block: "nearest" });
        });
    }

    function render() {
        scrollArea.innerHTML = "";
        scrollArea.scrollTop = 0;
        const currentSel = selWidget?.value || "";

        // Folders section
        if (folders.length) {
            const h = document.createElement("div");
            h.textContent = "Folders";
            Object.assign(h.style, { color: "#9ab", fontSize: "12px", margin: "0 0 6px 2px", fontFamily: "sans-serif" });
            scrollArea.appendChild(h);

            const fg = document.createElement("div");
            gridStyle(fg);
            fg.style.marginBottom = "16px";
            folders.forEach(f => {
                const c = card();
                const wrap = document.createElement("div");
                Object.assign(wrap.style, { position: "relative", height: thumbSize + "px", background: "#222" });

                const icon = document.createElement("div");
                icon.textContent = "📁";
                Object.assign(icon.style, {
                    fontSize: Math.round(thumbSize * 0.36) + "px", textAlign: "center", height: thumbSize + "px",
                    display: "flex", alignItems: "center", justifyContent: "center",
                });

                const cover = document.createElement("img");
                cover.loading = "lazy";
                cover.src = `${API}/cover?folder=${encodeURIComponent(folder)}` +
                    `&manual_path=${encodeURIComponent(manual_path)}&subpath=${encodeURIComponent(f.rel)}&size=${thumbSize}`;
                Object.assign(cover.style, { width: "100%", height: thumbSize + "px", objectFit: "cover", display: "block" });
                cover.onerror = () => { cover.style.display = "none"; icon.style.display = "flex"; };
                cover.onload = () => { icon.style.display = "none"; };
                icon.style.display = "none";

                const badge = document.createElement("div");
                badge.textContent = "📁";
                Object.assign(badge.style, {
                    position: "absolute", top: "3px", left: "3px", fontSize: "14px",
                    textShadow: "0 0 3px #000", pointerEvents: "none",
                });

                wrap.appendChild(cover);
                wrap.appendChild(icon);
                wrap.appendChild(badge);

                const cap = document.createElement("div");
                cap.textContent = f.name;
                Object.assign(cap.style, {
                    fontSize: "11px", color: "#ddd", padding: "4px 6px",
                    fontFamily: "sans-serif", whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis",
                });
                c.appendChild(wrap);
                c.appendChild(cap);
                c.addEventListener("click", () => { stack.push(f.rel); load(); });
                fg.appendChild(c);
            });
            scrollArea.appendChild(fg);
        }

        // Images section (paginated)
        const hi = document.createElement("div");
        hi.textContent = "Images";
        Object.assign(hi.style, { color: "#9ab", fontSize: "12px", margin: "0 0 6px 2px", fontFamily: "sans-serif" });
        scrollArea.appendChild(hi);

        if (!images.length) {
            const empty = document.createElement("div");
            empty.textContent = "(no images in this folder)";
            Object.assign(empty.style, { color: "#888", fontFamily: "sans-serif", fontSize: "13px", padding: "8px 2px" });
            scrollArea.appendChild(empty);
        } else {
            const ig = document.createElement("div");
            gridStyle(ig);
            const start = page * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, images.length);
            for (let k = start; k < end; k++) {
                const item = images[k];
                const borderColor = k === focus ? "#ffd24a" : (item.path === currentSel ? "#4aa3ff" : null);
                const c = card(borderColor);
                c.dataset.imgIdx = String(k);
                const img = document.createElement("img");
                img.loading = "lazy";
                img.src = `${API}/thumbnail?path=${encodeURIComponent(item.path)}`;
                Object.assign(img.style, { width: "100%", height: thumbSize + "px", objectFit: "cover", display: "block" });
                const cap = document.createElement("div");
                cap.textContent = item.name;
                Object.assign(cap.style, {
                    fontSize: "11px", color: "#ccc", padding: "4px 6px",
                    fontFamily: "sans-serif", whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis",
                });
                c.appendChild(img);
                c.appendChild(cap);
                // Single click previews the image; double click selects it.
                c.addEventListener("click", () => { focus = k; markFocus(); renderPreview(); });
                c.addEventListener("dblclick", () => { focus = k; selectFocused(); });
                ig.appendChild(c);
            }
            scrollArea.appendChild(ig);
        }

        // Pagination state
        const start = page * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, images.length);
        pageLabel.textContent = `Page ${page + 1}/${totalPages}`;
        info.textContent = images.length
            ? `${images.length} img — ${start + 1}-${end}`
            : "0 images";
        btnPrev.disabled = page <= 0;
        btnNext.disabled = page >= totalPages - 1;
        jumpInput.max = String(totalPages);
        jumpInput.value = page + 1;
        btnUp.disabled = stack.length <= 1;
    }

    function applySort() {
        images = sortImages(imagesRaw, criterion, asc);
        totalPages = Math.max(1, Math.ceil(images.length / PAGE_SIZE));
        page = 0;
        const sel = selWidget?.value || "";
        const idx = sel ? images.findIndex(it => it.path === sel) : -1;
        focus = idx >= 0 ? idx : (images.length ? 0 : -1);
        if (focus >= 0) page = Math.floor(focus / PAGE_SIZE);
        render();
        renderPreview();
    }

    function load() {
        const subpath = stack[stack.length - 1];
        pathLabel.textContent = "Loading...";
        fetch(`${API}/navigate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder, manual_path, sort_method, subpath }),
        })
            .then(r => r.json())
            .then(data => {
                if (data.status === "error") {
                    pathLabel.textContent = data.message || "Error";
                    folders = []; imagesRaw = []; images = []; totalPages = 1; page = 0; focus = -1;
                    render(); renderPreview();
                    return;
                }
                folders = data.folders || [];
                imagesRaw = data.images || [];
                pathLabel.textContent = "📂 " + (data.rel ? data.rel : "(root)");
                applySort();
            })
            .catch(e => { pathLabel.textContent = "Error: " + e.message; });
    }

    // Control events
    selSort.addEventListener("change", () => { criterion = selSort.value; LS.set("sort", criterion); applySort(); });
    selDir.addEventListener("change", () => { asc = selDir.value === "asc"; LS.set("dir", selDir.value); applySort(); });
    rangeSize.addEventListener("input", () => {
        thumbSize = parseInt(rangeSize.value, 10) || 150;
        sizeLabel.textContent = thumbSize + "px";
        LS.set("thumb", String(thumbSize));
        render();
    });

    btnUp.addEventListener("click", () => { if (stack.length > 1) { stack.pop(); load(); } });
    btnPrev.addEventListener("click", () => { if (page > 0) { page--; render(); } });
    btnNext.addEventListener("click", () => { if (page < totalPages - 1) { page++; render(); } });
    jumpInput.addEventListener("change", () => {
        let p = parseInt(jumpInput.value, 10);
        if (isNaN(p)) return;
        page = Math.max(1, Math.min(totalPages, p)) - 1;
        render();
    });
    btnPreImgPrev.addEventListener("click", () => setFocus(focus - 1));
    btnPreImgNext.addEventListener("click", () => setFocus(focus + 1));
    btnSelect.addEventListener("click", selectFocused);

    // If an image is already selected, open the gallery directly in its folder
    // (even inside subfolders) instead of starting at the root.
    const selected = selWidget?.value || "";
    if (selected) {
        pathLabel.textContent = "Locating...";
        fetch(`${API}/locate?folder=${encodeURIComponent(folder)}` +
              `&manual_path=${encodeURIComponent(manual_path)}&image=${encodeURIComponent(selected)}`)
            .then(r => r.json())
            .then(d => {
                if (d.status === "ok" && d.rel) {
                    const parts = d.rel.split(/[\\/]/).filter(Boolean);
                    stack.length = 0; stack.push("");
                    let acc = "";
                    for (const p of parts) { acc = acc ? acc + "/" + p : p; stack.push(acc); }
                }
                load();
            })
            .catch(() => load());
    } else {
        load();
    }
}

// --------------------------------------------------------------------------- //
// Extension
// --------------------------------------------------------------------------- //

app.registerExtension({
    name: "mlsuite.ImageLoader",
    async nodeCreated(node) {
        if (node.comfyClass !== "MLSuite_ImageLoader") return;

        const orig = node.onExecuted;
        node.onExecuted = function (message) {
            if (message?.next_index !== undefined) {
                const widget = getWidget(this, "start_index");
                if (widget) {
                    widget.value = message.next_index[0];
                }
            }
            if (orig) orig.apply(this, arguments);
        };

        node.addWidget("button", "Open folder", null, async () => {
            const folder = getWidget(node, "folder")?.value || "";
            const manual_path = getWidget(node, "manual_path")?.value || "";
            try {
                const resp = await fetch(`${API}/open-folder`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ folder, manual_path }),
                });
                const data = await resp.json();
                if (data.status === "error") alert(data.message);
            } catch (e) {
                alert("Could not open folder: " + e.message);
            }
        });

        node.addWidget("button", "Browse gallery", null, () => openGallery(node));

        node.addWidget("button", "Clear selection", null, () => {
            const selWidget = getWidget(node, "selected_image");
            const urlWidget = getWidget(node, "image_url");
            if (selWidget) selWidget.value = "";
            if (urlWidget) urlWidget.value = "";
            showInNode(node, null);
        });

        // Live preview when typing/pasting an image URL.
        const urlWidget = getWidget(node, "image_url");
        if (urlWidget) {
            const origCb = urlWidget.callback;
            urlWidget.callback = function () {
                if (origCb) origCb.apply(this, arguments);
                const val = String(urlWidget.value || "").trim();
                if (val) showInNode(node, val);
            };
        }

        // Restore the preview when loading a saved workflow (URL or selection).
        // Uploads are handled natively by ComfyUI.
        const origConfigure = node.onConfigure;
        node.onConfigure = function () {
            if (origConfigure) origConfigure.apply(this, arguments);
            const url = getWidget(this, "image_url")?.value;
            const sel = getWidget(this, "selected_image")?.value;
            if (url) showInNode(this, url);
            else if (sel) previewFromPath(this, sel);
        };
    }
});
