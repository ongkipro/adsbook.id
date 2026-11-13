# Not a landing route folder

> Verified against disk: 2026-11-13 @ `1403298`

Do **not** put landing pages here: a file in this folder would answer at
`/landing/<slug>`, and the URL contract is `domain.com/<slug>` with no prefix.

A native Astro landing page is `src/pages/<slug>.astro`, registered in
`src/data/native-landing-pages.ts`. The full contract is
`docs/design/LANDING-PAGES.md` in the adsbook.id-docs repository
(`../adsbook.id-docs/` from the repository root).
