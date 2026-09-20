# ComfyUI_MLSuite

[English](README.md) | **Español**

**MLSuite** es una colección de nodos personalizados para [ComfyUI](https://github.com/comfyanonymous/ComfyUI), pensada para un flujo de trabajo con imágenes más cómodo. Empieza con un potente **Image Loader** y seguirá creciendo.

> Idioma de la interfaz: **Inglés** (principal). Se incluyen traducciones al español vía `locales/`.

<!-- Añade una captura/GIF del nodo y descomenta la línea de abajo (guárdala como assets/screenshot.png):
![Image Loader](assets/screenshot.png)
-->

## Image Loader (Cargador de Imagen)

Un solo nodo para traer cualquier imagen a tu flujo de trabajo — desde una **subida**, una **URL directa**, un **explorador de galería visual**, o **rotando automáticamente** por una carpeta (ideal para datasets). Cada fuente muestra una vista previa dentro del nodo con las dimensiones reales.

### Características

- 🖼️ **Cuatro fuentes en un nodo** — subida, URL de imagen, selección desde la galería, o rotación automática por índice sobre una carpeta.
- 🗂️ **Explorador de galería integrado** — navega carpetas con miniaturas de portada, ordena por nombre/fecha, ajusta el tamaño de miniatura, previsualiza en un panel grande y selecciona con un clic (o doble clic).
- 👁️ **Vista previa consistente en el nodo** — la misma previsualización nativa para todas las fuentes.
- 🔁 **Rotación para datasets** — déjalo vacío y recorrerá la carpeta de forma recursiva, devolviendo la siguiente imagen en cada ejecución.
- 🌐 **Interfaz bilingüe** — inglés por defecto, español vía `locales/`.

### Entradas

| Entrada | Descripción |
|---------|-------------|
| `image` | Imagen subida a la carpeta `input` de ComfyUI. `(none)` para omitir. |
| `folder` | Carpeta base: una de las estándar de ComfyUI — `input`, `output`, `temp`. |
| `start_index` | Índice inicial de la rotación automática. |
| `sort_method` | Orden usado por la rotación (alfabético / numérico / fecha / aleatorio). |
| `image_url` *(opcional)* | URL directa de una imagen. Tiene prioridad sobre todo. |
| `manual_path` *(opcional)* | Cualquier ruta de carpeta absoluta. Tiene prioridad sobre `folder`. |
| `selected_image` *(opcional)* | Ruta de la imagen elegida en la galería. |

**Salida:** `IMAGE`.

### Resolución de la carpeta base

Sin rutas fijas. La carpeta base se resuelve así:

1. `manual_path` si está definido — se usa tal cual (pega cualquier ruta absoluta).
2. `folder` — una de las carpetas estándar de ComfyUI (`input`, `output`, `temp`).
3. Alternativa — la carpeta `input` de ComfyUI.

> [!NOTE]
> `manual_path` acepta cualquier carpeta absoluta para que puedas cargar desde
> tus propios directorios. Los archivos siempre se sirven a través de una lista
> blanca interna.

## Instalación

### ComfyUI Manager (recomendado)

Busca **MLSuite** en el ComfyUI Manager, haz clic en instalar y reinicia ComfyUI.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/marcolopezs/ComfyUI_MLSuite
pip install -r ComfyUI_MLSuite/requirements.txt
```

Luego reinicia ComfyUI.

## Uso

1. Añade el nodo **Image Loader** (categoría `MLSuite/image`).
2. Elige una fuente:
   - **URL** — pega un enlace en `image_url`.
   - **Subida** — elige un archivo en el desplegable `image`.
   - **Galería** — haz clic en **Browse gallery**, navega y selecciona una imagen.
   - **Rotación** — deja todo vacío y ejecuta repetidamente para recorrer una carpeta.
3. La imagen elegida se previsualiza dentro del nodo y sale por la salida `IMAGE`.

Botones extra: **Open folder** (abre la carpeta base en tu explorador de archivos) y **Clear selection** (limpia la selección).

## Licencia

[MIT](LICENSE) © MLSuite
