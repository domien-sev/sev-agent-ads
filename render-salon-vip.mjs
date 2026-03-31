/**
 * Render Le Salon VIP event awareness ads — static + video
 *
 * Generates:
 *   Static: 1:1, 4:5, 9:16 (NL + FR) — PNG
 *   Video:  1:1, 4:5, 9:16 (NL + FR) — MP4
 *
 * Usage: node render-salon-vip.mjs [--static] [--video] [--format 4x5] [--lang nl]
 * Default: all formats, both languages, static + video
 */
import puppeteer from "puppeteer";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const ADMIN_URL = "https://admin.shoppingeventvip.be";
const ADMIN_TOKEN = "xMyXxqn8O9zIaM8n2PqrqwSjQgv_oJrr";
const SEV_LOGO = "https://www.shoppingeventvip.com/cdn/shop/files/logo_1.png?v=1667984101";

const FPS = 30;

const FORMATS = {
  "9x16":   { w: 1080, h: 1920, label: "9:16 (Reels/Stories)" },
  "1x1":    { w: 1080, h: 1080, label: "1:1 (Feed)" },
  "4x5":    { w: 1080, h: 1350, label: "4:5 (Meta Feed)" },
  "191x1":  { w: 1200, h: 628,  label: "1.91:1 (Link Ad)" },
};

// --- Assets ---
const ASSETS_DIR = join(__dirname, "output", "salon-vip-assets");
const TMP_ASSETS = join(__dirname, "..", ".tmp", "assets-salon-vip");
const OUT_DIR = join(__dirname, "output", "salon-vip-ads");

// Featured brands to show logos for (the 9 hero brands with product imagery)
const FEATURED_BRANDS = [
  "amelie-amelie", "dvf", "lyle-scott", "river-woods",
  "cycleur-de-luxe", "hampton-bays", "blue-bay", "osaka", "les-cordes",
];

// Additional brands (logo only, for "and more")
const EXTRA_BRANDS = [
  "blakely", "sweet-lemon", "brax", "xandres", "woodwick",
  "jeff", "mia-zia", "birkenstock", "timberland",
];

// Brand spotlights for video — each entry maps a brand to its matching hero image
// Hero images are sorted alphabetically from the hero/ folder:
//   [0] hero-01 = Amelie & Amelie (beige beret)
//   [1] hero-02 = Lyle & Scott (eagle logo jacket)
//   [2] hero-03 = DVF (blue wrap dress)
//   [3] hero-04 = River Woods (couple in denim)
//   [4] hero-05 = Cycleur de Luxe (man with bike)
//   [5] hero-06 = Hampton Bays (orange/blue pattern)
//   [6] hero-07 = Blue Bay
//   [7] hero-08 = Osaka (padel)
//   [8] hero-09 = Les Cordes (jewelry/necklace)
//   [9] hero-10 = general event shot
const BRAND_HERO_MAP = [
  { brand: "dvf",              heroIndex: 2 },
  { brand: "lyle-scott",       heroIndex: 1 },
  { brand: "hampton-bays",     heroIndex: 5 },
  { brand: "osaka",            heroIndex: 7 },
  { brand: "cycleur-de-luxe",  heroIndex: 4 },
  { brand: "river-woods",      heroIndex: 3 },
  { brand: "les-cordes",       heroIndex: 8 },
  { brand: "amelie-amelie",    heroIndex: 0 },
];

// --- Layout tokens per format ---
function getTokens(w, h) {
  const s = Math.min(w, h);
  const isTall = h > w * 1.3;
  const isWide = w > h;
  const scale = (pct) => `${Math.round(s * pct / 100)}px`;

  // Meta safe zones — keep content away from platform UI overlays
  // 9:16 Reels/Stories: ~14% top (profile/close), ~18% bottom (CTA/captions), ~6% sides
  // 4:5 / 1:1 Feed: ~5% all around (slight extra bottom for "See More")
  // 1.91:1 Link ads: ~3% all around (minimal overlay)
  let safeTop, safeBottom, safeSide;
  if (isTall) {
    // 9:16 — heaviest UI overlay
    safeTop = `${Math.round(h * 0.13)}px`;
    safeBottom = `${Math.round(h * 0.17)}px`;
    safeSide = `${Math.round(w * 0.06)}px`;
  } else if (isWide) {
    // 1.91:1 — minimal
    safeTop = `${Math.round(h * 0.05)}px`;
    safeBottom = `${Math.round(h * 0.06)}px`;
    safeSide = `${Math.round(w * 0.04)}px`;
  } else {
    // 1:1, 4:5 — moderate
    safeTop = `${Math.round(h * 0.05)}px`;
    safeBottom = `${Math.round(h * 0.07)}px`;
    safeSide = `${Math.round(w * 0.05)}px`;
  }

  // Background position: wide formats need to show the top of portrait images (heads)
  const bgPosition = isWide ? "center 20%" : "center";

  return {
    WIDTH: String(w), HEIGHT: String(h),
    BG_POSITION: bgPosition,
    SAFE_TOP: safeTop, SAFE_BOTTOM: safeBottom, SAFE_SIDE: safeSide,
    // Top
    BADGE_SIZE: scale(2.2),
    SEV_LOGO_W: isTall ? "18%" : isWide ? "14%" : "18%",
    // Center
    CENTER_GAP: isTall ? scale(2) : scale(2.5),
    TITLE_SIZE: isTall ? scale(12) : isWide ? scale(9) : scale(11),
    DISC_GAP: scale(1.5),
    DISC_TEXT_SIZE: scale(3),
    DISC_BADGE_SIZE: scale(5.5),
    DISC_BADGE_PAD: `${scale(0.8)} ${scale(2)}`,
    SUBTITLE_SIZE: scale(2.2),
    // Info
    INFO_MT: scale(1.5),
    DATE_SIZE: scale(2.6),
    LOC_SIZE: scale(1.8),
    // CTA
    CTA_MT: scale(2),
    CTA_SIZE: scale(2),
    CTA_PAD: `${scale(1.5)} ${scale(4)}`,
    // Brands row
    BRAND_GAP: `${scale(1.2)} ${scale(2.5)}`,
    BRAND_PT: scale(1.5),
    BRAND_H: isTall ? scale(3.5) : scale(4),
    BRAND_MAX_W: isTall ? scale(14) : scale(16),
    MORE_SIZE: scale(1.8),
    // Video spotlight
    SPOT_GAP: scale(3),
    SPOT_LOGO_H: scale(12),
    SPOT_X_SIZE: scale(4),
    SPOT_SALON_SIZE: scale(8),
    // Meta
    SEV_LOGO_URL: SEV_LOGO,
  };
}

// --- Language variants ---
function getLangTokens(lang) {
  if (lang === "fr") {
    return {
      DISCOUNT_PREFIX: "Jusqu'à",
      DISCOUNT_SUFFIX: "de réduction",
      SUBTITLE: "Liquidation grandes marques",
      MONTH: "avril",
      CTA_TEXT: "Réservez votre place",
      MORE_TEXT: "et bien plus encore…",
    };
  }
  return {
    DISCOUNT_PREFIX: "Tot",
    DISCOUNT_SUFFIX: "korting",
    SUBTITLE: "Liquidatie topmerken",
    MONTH: "april",
    CTA_TEXT: "Reserveer je ticket",
    MORE_TEXT: "en nog veel meer…",
  };
}

// --- Local file server for assets ---
let _server = null;
let _port = 0; // auto-assign available port

async function startAssetServer() {
  return new Promise((resolve) => {
    _server = createServer((req, res) => {
      // Serve from multiple directories
      const decodedPath = decodeURIComponent(req.url).replace(/^\//, "");
      const candidates = [
        join(ASSETS_DIR, decodedPath),
        join(TMP_ASSETS, decodedPath),
      ];

      for (const filePath of candidates) {
        if (existsSync(filePath)) {
          const ext = filePath.split(".").pop().toLowerCase();
          const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
          res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
          createReadStream(filePath).pipe(res);
          return;
        }
      }
      res.writeHead(404);
      res.end("Not found: " + decodedPath);
    });
    _server.listen(_port, () => {
      _port = _server.address().port; // read actual assigned port
      console.log(`  Asset server on http://localhost:${_port}`);
      resolve();
    });
  });
}

function assetUrl(relativePath) {
  return `http://localhost:${_port}/${encodeURIComponent(relativePath)}`;
}

// Brands whose white logo already looks correct and should NOT get brightness(10)
const NO_BRIGHTEN = new Set(["river-woods"]);

function brandLogoImg(name, extraClass = "") {
  const logoPath = `brand-logos-white/${name}.png`;
  const cls = NO_BRIGHTEN.has(name) ? `${extraClass} no-brighten`.trim() : extraClass;
  const classAttr = cls ? ` class="${cls}"` : "";
  return `<img${classAttr} src="${assetUrl(logoPath)}" alt="${name}">`;
}

// --- Collect hero images ---
async function getHeroImages() {
  const heroDir = join(ASSETS_DIR, "hero");
  const files = (await readdir(heroDir)).filter(f => f.endsWith(".webp")).sort();
  return files.map(f => `hero/${f}`);
}

// --- Build static HTML ---
function buildStatic(template, lang, w, h, heroImage) {
  let html = template;
  const tokens = { ...getTokens(w, h), ...getLangTokens(lang) };

  tokens.HERO_IMAGE = assetUrl(heroImage);

  for (const [k, v] of Object.entries(tokens)) {
    html = html.replaceAll(`{{${k}}}`, v);
  }

  // Brand logos — show 9 featured
  const logoHtml = FEATURED_BRANDS.map(name => brandLogoImg(name)).join("\n      ");
  html = html.replace("{{BRAND_LOGOS}}", logoHtml);

  return html;
}

// --- Build video HTML ---
function buildVideo(template, lang, w, h, heroImages) {
  let html = template;
  const tokens = { ...getTokens(w, h), ...getLangTokens(lang) };

  // Build the hero sequence: intro hero (general) + one per brand spotlight
  // Each brand spotlight gets its matching lifestyle hero image
  const introHeroIndex = 9; // hero-10 = general event shot
  const spotlightEntries = BRAND_HERO_MAP.slice(0, 7); // max 7 brand transitions
  const heroSequence = [introHeroIndex, ...spotlightEntries.map(e => e.heroIndex)];
  const heroCount = heroSequence.length;

  tokens.HERO_COUNT = String(heroCount);
  tokens.BRAND_SPOT_COUNT = String(spotlightEntries.length);
  tokens.AUTOPLAY = "false"; // Puppeteer controls

  // Phase durations — MAX 12 seconds total
  // Intro ~1.5s + 8 brands × 0.7s = 5.6s + Outro ~2.5s = ~9.6s (leaves headroom)
  const PHASE = {
    fadeIn: 250, introHold: 500, discountIn: 200, subtitleIn: 150, hold1: 300,
    heroTransition: 200, spotlightIn: 150, spotlightHold: 400, spotlightOut: 150, heroHold: 100,
    infoIn: 200, ctaIn: 150, brandsIn: 250, outroHold: 1500,
  };
  const heroCycle = PHASE.heroTransition + PHASE.spotlightIn + PHASE.spotlightHold + PHASE.spotlightOut + PHASE.heroHold;
  const totalMs = PHASE.fadeIn + PHASE.introHold + PHASE.discountIn + PHASE.subtitleIn + PHASE.hold1
    + spotlightEntries.length * heroCycle
    + PHASE.infoIn + PHASE.ctaIn + PHASE.brandsIn + FEATURED_BRANDS.length * 80 + 400 + PHASE.outroHold;

  tokens.TOTAL_MS = String(totalMs);

  for (const [k, v] of Object.entries(tokens)) {
    html = html.replaceAll(`{{${k}}}`, v);
  }

  // Hero layers — ordered by the sequence (intro first, then brand-matched heroes)
  const heroLayersHtml = heroSequence.map((heroIdx, i) => {
    const img = heroImages[heroIdx] || heroImages[0];
    return `<div class="hero-layer" id="hero${i}" style="background-image:url('${assetUrl(img)}')"></div>`;
  }).join("\n  ");
  html = html.replace("{{HERO_LAYERS}}", heroLayersHtml);

  // Brand spotlights — each mapped to its matching hero transition
  const spotHtml = spotlightEntries.map((entry, i) => {
    const noBrighten = NO_BRIGHTEN.has(entry.brand) ? ' class="no-brighten"' : '';
    return `<div class="brand-spotlight" id="spot${i}">
    <img${noBrighten} src="${assetUrl(`brand-logos-white/${entry.brand}.png`)}" alt="${entry.brand}">
    <span class="x-mark">×</span>
    <span class="salon-text">Le Salon VIP</span>
  </div>`;
  }).join("\n  ");
  html = html.replace("{{BRAND_SPOTLIGHTS}}", spotHtml);

  // Brand logos row
  const logoHtml = FEATURED_BRANDS.map(name => brandLogoImg(name)).join("\n      ");
  html = html.replace("{{BRAND_LOGOS}}", logoHtml);

  return { html, totalMs };
}

// --- Render static PNG ---
async function renderStatic(html, w, h, outPath) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 500)); // let images load
  await page.screenshot({ path: outPath, type: "png", clip: { x: 0, y: 0, width: w, height: h } });
  await browser.close();
  console.log(`  ✓ ${outPath.split(/[\\/]/).pop()}`);
}

// --- Render video MP4 ---
async function renderVideo(html, totalMs, w, h, outPath) {
  const frDir = outPath.replace(".mp4", "-frames");
  await mkdir(frDir, { recursive: true });
  const totalFrames = Math.ceil(FPS * totalMs / 1000);
  const dpr = Math.max(w, h) > 1080 ? 1 : 2;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 1000)); // preload images

  process.stdout.write(`  Capturing ${totalFrames} frames...`);
  const dt = 1000 / FPS;
  for (let i = 0; i < totalFrames; i++) {
    await page.evaluate(ms => window.setTime(ms), i * dt);
    await new Promise(r => setTimeout(r, 30));
    const buf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: w, height: h } });
    await writeFile(join(frDir, `f${String(i).padStart(5, "0")}.png`), buf);
    if (i % (FPS * 5) === 0) process.stdout.write(` ${(i * dt / 1000).toFixed(0)}s`);
  }
  console.log(" done");
  await browser.close();

  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${join(frDir, "f%05d.png")}" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset fast "${outPath}"`,
    { stdio: "pipe" }
  );
  console.log(`  ✓ ${outPath.split(/[\\/]/).pop()}`);
}

// --- CLI args ---
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { doStatic: true, doVideo: true, formats: null, langs: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--static") { opts.doStatic = true; opts.doVideo = false; }
    if (args[i] === "--video")  { opts.doVideo = true; opts.doStatic = false; }
    if (args[i] === "--format" && args[i+1]) { opts.formats = [args[++i]]; }
    if (args[i] === "--lang" && args[i+1]) { opts.langs = [args[++i]]; }
  }

  // If both flags explicitly set
  if (args.includes("--static") && args.includes("--video")) {
    opts.doStatic = true;
    opts.doVideo = true;
  }

  return opts;
}

// --- Main ---
async function main() {
  const opts = parseArgs();
  const formats = opts.formats
    ? opts.formats.map(f => [f, FORMATS[f]]).filter(([,v]) => v)
    : Object.entries(FORMATS);
  const langs = opts.langs || ["nl", "fr"];

  await mkdir(OUT_DIR, { recursive: true });
  await startAssetServer();

  const heroImages = await getHeroImages();
  console.log(`\nLe Salon VIP — Ad Generator`);
  console.log(`  Hero images: ${heroImages.length}`);
  console.log(`  Featured brands: ${FEATURED_BRANDS.length}`);
  console.log(`  Formats: ${formats.map(([k, v]) => v.label).join(", ")}`);
  console.log(`  Languages: ${langs.join(", ")}`);
  console.log();

  // --- Static ads ---
  if (opts.doStatic) {
    console.log("=== STATIC ADS ===");
    const staticTemplate = await readFile(
      join(__dirname, "templates", "banners", "salon-vip-static.html"), "utf-8"
    );

    // Use hero-01 as the main image for statics (the elegant beige outfit)
    const mainHero = heroImages[0];

    for (const [fmtKey, fmt] of formats) {
      for (const lang of langs) {
        console.log(`[${fmtKey}] ${fmt.label} — ${lang.toUpperCase()}`);
        const html = buildStatic(staticTemplate, lang, fmt.w, fmt.h, mainHero);
        const htmlPath = join(OUT_DIR, `static-${fmtKey}-${lang}.html`);
        await writeFile(htmlPath, html);
        await renderStatic(html, fmt.w, fmt.h, join(OUT_DIR, `static-${fmtKey}-${lang}.png`));
      }
    }
    console.log();
  }

  // --- Video ads ---
  if (opts.doVideo) {
    console.log("=== VIDEO ADS ===");
    const videoTemplate = await readFile(
      join(__dirname, "templates", "banners", "salon-vip-video.html"), "utf-8"
    );

    for (const [fmtKey, fmt] of formats) {
      for (const lang of langs) {
        console.log(`[${fmtKey}] ${fmt.label} — ${lang.toUpperCase()}`);
        const { html, totalMs } = buildVideo(videoTemplate, lang, fmt.w, fmt.h, heroImages);
        const htmlPath = join(OUT_DIR, `video-${fmtKey}-${lang}.html`);
        await writeFile(htmlPath, html);
        await renderVideo(html, totalMs, fmt.w, fmt.h, join(OUT_DIR, `video-${fmtKey}-${lang}.mp4`));
      }
    }
    console.log();
  }

  _server.close();
  console.log("All done! Output in:", OUT_DIR);
}

main().catch(console.error);
