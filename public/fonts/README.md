# Fonts

`fraunces-latin.woff2` and `fraunces-latin-ext.woff2` are the [Fraunces](https://github.com/undercasetype/Fraunces)
variable font — latin and latin-ext subsets — carrying four axes:

| axis | range | used for |
| --- | --- | --- |
| `opsz` | 9 – 144 | 9 for small-caps labels, 144 for the hanging hour numerals |
| `wght` | 100 – 900 | |
| `SOFT` | 0 – 100 | softens the display sizes |
| `WONK` | 0 – 1 | the swapped-in alternate letterforms |

The app is in Slovak, which needs the caron letters (č š ž ť ď ň ľ ĺ ŕ). Those
live in latin-ext rather than latin, so both subsets ship and `unicode-range`
lets the browser take only the half it needs.

It is served from this origin rather than a font CDN, so the app makes no
third-party requests, works offline, and leaks nothing about who is reading it.

Copyright 2018 The Fraunces Project Authors, licensed under the SIL Open Font
License 1.1 — see `OFL.txt`.
