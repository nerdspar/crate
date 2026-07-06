# Crate — Spine & Case Rendering Spec

Companion to `BUILD_PLAN.md` §4–§5. The prototype `spine-shelf.html` is **canonical** — this document explains what's in it, why, and how real artwork data plugs in. When porting to `apps/shelf`, copy the CSS/JS treatments exactly; the values below were visually tuned and approved.

## Design intent

Spines must read as physical CD jewel cases, not colored UI bars. Three layers create this:
1. **Materials** — plastic case rendering (always on)
2. **Color/texture** — derived from real album artwork (pipeline output)
3. **Typography** — per-album variation so the shelf reads as a collection of different record labels

## 1. Materials (implemented in prototype — port as-is)

### Spine face (`.face-spine::before`)
A fixed-pixel plastic edge treatment, independent of spine width:
- **Top edge:** 1px light catch-line (`rgba(210,215,225,0.35)`) → 1px dark seam → ~2px translucent plastic → ~3px shadow falloff → paper. Total ≈ 8px.
- **Bottom edge:** mirrored, slightly darker (cases sit in shadow at the base).
- **Vertical gloss:** left-biased highlight (`rgba(255,255,255,0.16)` → transparent by 32%) and right-side shading (`rgba(0,0,0,0.34)` at 100%) across the full spine.
- Edges are **fixed px, never percentages** — a 1–2mm plastic lip looks the same on a thin single and a fat double album, exactly like reality.

### Label containment
`.spine-label` max-height 86%; `v-top`/`v-bottom` variants use 16px margins so text never touches the plastic edge.

### Catalog imprint (`.cat`)
On spines with base width ≥ 28: an 8px `ui-monospace` vertical line near the foot (bottom: 14px), 0.5 opacity, in the computed ink color. Prototype shows a mock year; production shows the **release year** from metadata. Skip when unknown.

### Cover face (`.face-cover::after`) — the jewel case front
The art renders *under* clear plastic:
- **Hinge strip, left edge (~15px):** the case's spine-side hinge — dark seam, 1px light ridge, translucent plastic band fading inward. The asymmetry (left heavier than the other three edges) is what sells the object; do not make it uniform.
- **Thin frame, top/bottom/right (~6px):** 1px catch-line + short shadow falloff each.
- **Diagonal gloss:** 112° sweep, `rgba(255,255,255,0.15)` at origin fading through transparent mid-cover, faint pickup at far corner.
- Overlay lives on the cover face itself so gloss **rotates with the 3D flip** — keep it there, not on a parent.
- Corner buttons (`.cover-btn`, z-index 4) sit above the overlay; overlay is `pointer-events: none`.

## 2. Color & texture from real artwork

Replaces the prototype's hand-picked `c1`/`c2` colors. Per album, the artwork pipeline (BUILD_PLAN §4) produces:
- `palette`: dominant + dark variant via node-vibrant → spine gradient `linear-gradient(90deg, dark, dominant 45%, dark)` and cover fallback background
- `spineStrip`: 1px-wide center slice of the cover, stretched to spine height, heavy gaussian blur, saved as small PNG → used as spine background in `art` mode
- `ink`: light/dark label color via luminance (port `pickInk()` from prototype)
- `scan` (when available): real spine image from MusicBrainz Cover Art Archive ("spine" image type on the matched release). When used, suppress the generated label text and catalog imprint — the scan contains its own — but **keep the materials layer** (§1) on top for consistency with generated neighbors.

Render mode is a user setting (`palette` default | `art` | `scan` preferred with fallback). Per-album override in admin.

## 3. Typography system (implemented in prototype — port as-is)

`TYPE_STYLES`: six styles across Archivo Narrow / Oswald / Newsreader with varied weight, casing, and tracking. Assignment is `TYPE_STYLES[hashStr(artist) % 6]` — deterministic per artist, so an artist's albums share a "label identity" and the same shelf always renders identically. Newsreader styles get a slightly larger size multiplier (0.66 vs 0.6) for optical parity.

Font size: `min(baseWidth × multiplier, 19px)`. Fonts must be **bundled locally** in production (no Google Fonts dependency on the kiosk).

Do not add randomness beyond the hash; determinism is a feature (stable shelf, stable screenshots, cacheable renders).

## 4. Spine width

Prototype uses mock widths. Production: width derived from **track count / total duration** (a 78-minute double album is visibly fatter than a 34-minute record), clamped to sensible min/max, stored on the shelf item so layout math (`settledLeft`) stays deterministic.

## 5. Acceptance checklist

- [ ] Plastic edges are thin (≈6–8px) and fixed-px on all spine widths
- [ ] Cover overlay: heavier left hinge, thin frame elsewhere, diagonal gloss; rotates with the flip
- [ ] Labels never overlap plastic edges in any of the three label-style settings
- [ ] Typography varies across the shelf; same artist → same style on every load
- [ ] Year imprint appears only on wide spines with known release year
- [ ] Real palette/art-strip/scan modes all render under the same materials layer
- [ ] `pickInk` contrast holds on real artwork palettes (test pathological covers: pure white, pure black, high-chroma)
