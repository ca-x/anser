# Anser website

The website uses React, Cloudflare Kumo, and Vite. Start it locally with Node.js 24.

```sh
npm --prefix website ci
npm --prefix website run dev
```

Publishing uses GitHub Actions as the GitHub Pages source. Changes to the website or its images on `main` deploy automatically. To start a deployment manually, run `gh workflow run pages.yml --ref main`.

The build uses relative asset paths so the same output works at the repository Pages URL and at a custom domain. Configure the domain in the repository Pages settings and point DNS there.
