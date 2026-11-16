# Remote pointer

The pointer tools drive the real mouse in the tab you already have open. They exist for the surfaces where a DOM click is not enough: canvas charts, map widgets, sliders, drag handles, and anything that only reacts to `mousemove`.

Every pointer call goes through `chrome.debugger` and `Input.dispatchMouseEvent`, exactly like `browser_click` with `trusted: true`. Two consequences follow:

- The debugger attaches lazily and detaches after 30 seconds idle.
- Chrome shows its debugging notice on that tab while the tools are in use.

## Coordinate spaces

| Space | Meaning | When |
| --- | --- | --- |
| `viewport` (default) | CSS pixels from the top-left of the visible viewport | Matches `browser_screenshot` of the viewport and the coordinates reported by `browser_get_box().viewport` |
| `page` | CSS pixels from the top-left of the document | Use after you already hold document coordinates, or when the page scrolls between the read and the move |

`browser_get_box` returns both, plus `scroll`, `viewportSize`, and `devicePixelRatio`, so a coordinate can always be converted:

```
viewport = page - scroll
page     = viewport + scroll
```

Screenshots report the CSS box they captured and the pixel scale, so a pixel position in the image maps back with:

```
coordinate = css.x + (pixelX / deviceScaleFactor)
```

## Tools

| Tool | Use |
| --- | --- |
| `browser_mouse_move` | Move the pointer. `steps > 1` sends a travel path, which some canvas apps need before they update |
| `browser_mouse_click` | Press and release at a point, with optional `modifiers` |
| `browser_mouse_down` / `browser_mouse_up` | Hold a button, then release elsewhere |
| `browser_mouse_drag` | Press, travel, release. Sliders, range handles, canvas panning |
| `browser_mouse_wheel` | Wheel at a point. Chart zoom, panel scroll, wheel-driven sliders |
| `browser_pointer_probe` | Move, then report the element stack and the DOM nodes that changed near the pointer |
| `browser_get_box` | Box of an element in viewport and page space |
| `browser_pick_region` | Overlay a crosshair, let the person drag the rectangle, return its coordinates and optionally a PNG |

Aim at an element instead of computing pixels by passing `ref` or `selector` with optional `offsetX`/`offsetY`. The point is the element centre plus the offsets, and the element is scrolled into view first.

## Pick a region by hand

Guessing coordinates from a screenshot is the slow path. `browser_pick_region` puts a crosshair over the page and lets the person drag the exact rectangle.

```text
picked = browser_pick_region { capture: true }
```

It returns:

```json
{
  "cancelled": false,
  "viewport": { "x": 412, "y": 233, "width": 320, "height": 160 },
  "page": { "x": 412, "y": 233, "width": 320, "height": 160 },
  "scroll": { "x": 0, "y": 0 },
  "viewportSize": { "width": 1920, "height": 940 },
  "devicePixelRatio": 1,
  "element": "canvas \"Liquidation heatmap\""
}
```

- Pass `ref` or `selector` to confine the overlay to one element, so the person can only pick inside the chart.
- `capture: true` also returns a PNG of that rectangle, already cropped.
- Escape cancels and the tool reports `cancelled: true`, not an error.
- The result is exactly what `browser_screenshot { region }` and the `browser_mouse_*` tools expect, so no conversion is needed.

Use it when a person is present. When nobody is watching, fall back to `browser_get_box` plus arithmetic.

## Checklist

Run this once per page before you trust a sampled grid.

1. `browser_status` → `bridge.state` is `connected` and the target tab is the one you mean.
2. `browser_get_box` on the canvas or panel → `viewport.width` is greater than 0 and inside `viewportSize`.
3. `browser_mouse_move` to the centre of that box → a crosshair, hover ring, or highlight appears in a new `browser_screenshot`.
4. `browser_pointer_probe` at the same point → read the result:
   - `changes` lists a node with the tooltip text, or `at_point.top.selector` is the tooltip → the tooltip is DOM. Read it with `browser_get_text` and the selector the probe returned.
   - `changes` is empty and only the canvas is under the pointer → the tooltip is painted on the canvas. Read pixels from `browser_screenshot` with `region` instead.
5. Sweep the grid with `browser_mouse_move`, one call per cell, and read the tooltip after each move.
6. Repeat `browser_get_box` after any scroll, zoom, or layout change. Stale boxes produce points that look right and land wrong.
7. For a slider, prefer `browser_mouse_drag` from the thumb to the target position, then confirm the value with `browser_get_text` on the value label.
8. Keep the sample honest: a screenful of cells is not the whole dataset, and a model estimate is not an executed event.

## Canvas example

```text
1. box  = browser_get_box { selector: "canvas" }
2. probe = browser_pointer_probe { x: box.viewport.x + 200, y: box.viewport.y + 120 }
3. If probe found a DOM tooltip selector:
     for each cell:
       browser_mouse_move { x, y }
       browser_get_text { selector: <tooltip selector> }
   Otherwise:
     browser_mouse_move { x, y }
     browser_screenshot { region: { x: 0, y: 0, width: 320, height: 160 } }
```

Step 2 is the part worth doing once. A DOM tooltip turns every cell into one small text read instead of a screenshot and an OCR pass.

## Slider example

```text
box   = browser_get_box { selector: "#threshold" }
from  = { x: box.viewport.x + box.viewport.width / 2, y: box.viewport.y + box.viewport.height / 2 }
to    = { x: box.viewport.x + box.viewport.width - 6, y: from.y }
browser_mouse_drag { from, to, steps: 8 }
```

For coarse steps, `browser_mouse_wheel` over a focused slider or `browser_press_key` with an arrow key is often steadier than a long drag.

## Errors

| Code | Meaning | Fix |
| --- | --- | --- |
| `point_out_of_viewport` | The point is outside the visible viewport | Correct the point, or pass `space: "page"`, or scroll first |
| `pointer_disabled` | Coordinate control is off in the extension options | Turn on **Allow coordinate pointer control** |
| `missing_point` | Neither `x`/`y` nor `ref`/`selector` was given | Pass a point or a target |
| `missing_delta` | Wheel call without `deltaX` or `deltaY` | Pass a delta, one notch is about 100 |
| `cdp_unavailable` | DevTools is open on that tab, or policy blocks the debugger | Close DevTools for that tab |
| `element_not_found` / `stale_ref` | The target moved | Call `browser_get_box` or `browser_snapshot` again |
