# Glass

Drop a logo, get it back as a glass app icon. Live at [phileeppov.com/glass](https://phileeppov.com/glass), where changes land first. I designed it and built it with Claude Code.

![The smiley logo turns into a glass app icon, moves through three presets and settles back flat](media/glass.gif)

Upload an SVG, PNG or JPG, drop it on the page, paste one from Figma, or type a letter, a word or an emoji. A logo on white loses the white background, and a square photo or app icon fills the glass.

Out comes a 1080p video, square or 16:9, or a PNG: 1024 or 2048 px, an avatar for round profile pictures, or a square App Store icon. Everything runs in the browser, so the logo never leaves it.

Turn on Sound and the glass reacts to the demo tune, your mic or your own track. Bass lights the red end of the fringe, highs the violet one, and the beat pulls the logo into the rim. The video keeps the sound too.

## How it works

One fragment shader in WebGL 1: the logo becomes a signed distance field ([`src/sdf.js`](src/sdf.js)), so where the glass magnifies it, the edge stays smooth instead of going blocky. The rim pulls the logo out to the edge, and each pixel there averages 32 samples across the spectrum, every color bent a little differently, which is where the rainbow fringe comes from ([`src/renderer.js`](src/renderer.js)). The Facets switch in Advanced cuts the rim into two flat faces, so the logo's edge shows twice, with a sharp step between them.

Sound goes through Web Audio: eight frequency bands, 40 Hz to 12 kHz, each tied to its own stretch of the rainbow fringe, plus the beats ([`src/sound.js`](src/sound.js)). The demo tune is struck glass, a few sine partials per note, rendered in the browser ([`src/tune.js`](src/tune.js)).

Each thing you do fires a `glass:tell` event, like `png` or `sound:mic`, and nothing in this repo listens to them. On phileeppov.com a small script counts them by name, never a logo, a file name or a slider value.

## Run it

No build step and no dependencies. From the repo folder, start any static server, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 (on Windows the command is `python`). Opening `index.html` straight from disk won't work: most browsers block ES modules on `file://`.

## License

MIT for the code. The Onest font in `fonts/` is under the SIL Open Font License, see [`fonts/OFL-Onest.txt`](fonts/OFL-Onest.txt).
