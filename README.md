# Swatch First

Randomized Ravelry project preview for any pattern.

Search for a knitting or crochet pattern (or click one of the popular examples) and see 8 random finished-project photos from Ravelry, so you can get a feel for how a pattern looks on real people before you cast on. Hit refresh for 8 more.

**Live site:** https://swatchfirst.com/

## Built with

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) (`src/worker.js`) that serves the page from `public/` and proxies the [Ravelry API](https://www.ravelry.com/api).

## Running locally

1. `npm install`
2. Create `.dev.vars` with your Ravelry read-only API credentials:
   ```
   RAVELRY_USER=...
   RAVELRY_PASSWORD=...
   ```
3. `npm run dev` and open http://localhost:8787

## Deploying

`npm run deploy`. Production credentials are Worker secrets (`npx wrangler secret put RAVELRY_USER`, same for `RAVELRY_PASSWORD`).
