# SnapShrink

**Convert, compress and resize images 100% in the browser — zero uploads.**

A single-page, dependency-free web tool that turns heavy PNGs and photos into lightweight
WebP, JPEG or PNG files on the visitor's own device. Built as static files so it can be
hosted anywhere, including GitHub Pages, and keep working offline.

Live: <https://lkj-droid.github.io/snapshrink/>

## Features

- **Batch input** — drag & drop, file picker, clipboard paste, or ⌘/Ctrl+O. PNG, JPEG, WebP, GIF and BMP, up to 40 files per batch.
- **Output formats** — WebP (default), JPEG, PNG, with runtime detection of WebP encoding support and a JPEG fallback.
- **Quality slider (10–100%)** — every image is re-encoded live, with per-image before/after size and a savings badge.
- **Resize presets** — original, max width 1920 px / 1080 px, or a fixed box with aspect-ratio lock and crop-to-fill / fit-inside modes. Built-in platform sizes: YouTube thumbnail 1280×720, Instagram post 1080×1080, Instagram story 1080×1920, X post 1600×900, link preview (OG) 1200×630, Pinterest pin 1000×1500 and app icon 512×512 — each also available as a one-click card in the “Platform sizes” section.
- **Downloads** — one file at a time, or every result in a ZIP assembled by a built-in ~100-line ZIP writer (CRC-32, stored entries, no CDN).
- **Privacy by architecture** — no upload endpoint, no analytics, no external requests. Image data never leaves the tab.
- **Accessible, responsive UI** — dark and light themes (system preference, remembered), keyboard support, ARIA live regions, 390 px phone through 1440 px desktop.

## Structure

```
index.html      converter + FAQ + SEO/JSON-LD
styles.css      design system, dark/light themes, responsive layout
app.js          decoding, resize geometry, encoding, ZIP writer, UI
privacy.html    what the site does and does not store
about.html      how it works and what it cannot do
terms.html      terms of use
robots.txt      crawler rules + sitemap pointer
sitemap.xml     sitemap template
favicon.svg     icon
og-cover.png    1200×630 social preview card
```

## Run locally

Any static server works; there is no build step.

```bash
python3 -m http.server 8000
# open http://127.0.0.1:8000/
```

## Deploy to GitHub Pages

1. Push these files to the root of a public repository's `main` branch.
2. Settings → Pages → Source: *Deploy from a branch* → branch `main`, folder `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/`.

If you rename the repository or move to a custom domain, update the absolute URLs in
`index.html` (`canonical`, Open Graph, Twitter), `sitemap.xml`, `robots.txt`, and the
canonical links on the sub-pages.

## Enabling ads (optional)

`index.html` contains a commented-out AdSense snippet in `<head>`. Replace
`ca-pub-XXXXXXXXXXXXXXXX` with your publisher ID and uncomment it. Advertising is the only
thing that would ever make a network request from this page — the converter itself has no
dependency on it and keeps working with any ad blocker. Update `privacy.html` §5 if you
enable it.

## Browser support

Current Chrome, Edge, Firefox and Safari. WebP encoding is detected at runtime; browsers
without it fall back to JPEG automatically. HEIC/HEIF input is not supported by canvas in
any browser — export to JPEG first.

## License

The code is free to use, modify and self-host. Inter (used only in the rendered preview
screenshots) is not bundled; the page relies on the visitor's system UI font.
