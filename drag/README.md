# Launch Control — 0–100 km/h on a drag strip

A standalone page in `drag/` that compares 39 cars' 0–100 km/h times and races up
to four of them side by side on a top-down, to-scale quarter-mile drag strip.

Open `drag/index.html` through any static server (ES modules don't load from
`file://`), e.g. `cd tests && npm run serve` → http://localhost:8099/drag/.

| File | Role |
|---|---|
| `data.js` | Cars, published figures and their sources |
| `physics.js` | Acceleration model, calibration, timing slip |
| `strip.js` | Canvas renderer: strip, cars, tyre smoke, minimap |
| `charts.js` | Speed-over-time chart and the 0–100 ranking |
| `app.js` | Lane selection, start tree, race loop, scoreboards, table |

## The model

`a(v, t) = min(A·launch(t), P/v) − k·v² − Crr·g`: a traction limit, a power limit
and drag. `A` and `P` are solved per car so the model reproduces the published
0–100 km/h time exactly, plus a second published figure where one exists
(an official 0–200 km/h time or a magazine quarter-mile ET). Cars with only a
0–100 figure get typical wheel power (a share of rated power) and the grip is
solved from the 0–100 time. Quarter-mile
numbers use drag-strip conventions: 1 ft rollout, 66 ft speed trap.

Tests: `tests/unit/drag-physics.test.js` (`cd tests && npm run test:unit`).
