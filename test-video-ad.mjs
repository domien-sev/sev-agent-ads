/**
 * Full sale-driven video ad pipeline:
 * 1. Fetch event from admin.shoppingeventvip.be
 * 2. Fetch products from Shopify
 * 3. Remove backgrounds with rembg
 * 4. Render 4 video formats (9:16, 1:1, 4:5, 16:9) in NL + FR
 *
 * Usage: node test-video-ad.mjs [event-id]
 * Default: Timberland sale
 */
import puppeteer from "puppeteer";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_URL = "https://admin.shoppingeventvip.be";
const ADMIN_TOKEN = process.env.WEBSITE_COLLAB_DIRECTUS_TOKEN;
const SEV_LOGO = "https://www.shoppingeventvip.com/cdn/shop/files/logo_1.png?v=1667984101";

const FPS = 30;
const INTRO_MS = 3000;
const PROD_MS = 3500;
const OUTRO_MS = 4000;
const MAX_PRODUCTS = 6;

const FORMATS = {
  "9x16":  { w: 1080, h: 1920, label: "9:16 (Reels/TikTok/Stories)" },
  "1x1":   { w: 1080, h: 1080, label: "1:1 (Feed)" },
  "4x5":   { w: 1080, h: 1350, label: "4:5 (Meta Feed)" },
  "16x9":  { w: 1920, h: 1080, label: "16:9 (YouTube)" },
};

// Layout tokens per format — scaled proportionally
function getTokens(w, h) {
  const s = Math.min(w, h); // base scale
  const isWide = w > h;
  const isTall = h > w * 1.3;
  const scale = (pct) => `${Math.round(s * pct / 100)}px`;

  return {
    WIDTH: String(w), HEIGHT: String(h),
    // Circle — larger, more visible
    CIRCLE_W: `${Math.round(s * 0.7)}px`, CIRCLE_R: `${Math.round(s * -0.08)}px`, CIRCLE_T: `${Math.round(s * -0.03)}px`,
    // Padding
    PAD: `${Math.round(s * 0.05)}px ${Math.round(s * 0.06)}px`,
    // Logo
    LOGO_W: isTall ? "50%" : isWide ? "22%" : "40%",
    LOGO_MB: scale(2),
    SM_LOGO_T: scale(2.5), SM_LOGO_R: scale(2.5), SM_LOGO_W: isTall ? "22%" : isWide ? "12%" : "20%",
    // Tagline — bigger
    TAG_SIZE: isTall ? scale(6) : isWide ? scale(4.5) : scale(5.5),
    // CTA
    CTA_SIZE: scale(2.5), CTA_PAD: `${scale(1.6)} ${scale(3.5)}`,
    CTA_FIX_B: scale(3), CTA_FIX_L: scale(4),
    CTA_FIX_SIZE: scale(2.2), CTA_FIX_PAD: `${scale(1.3)} ${scale(2.8)}`,
    // Product image — BIGGER, more centered
    IMG_MAX_H: isTall ? "55%" : isWide ? "75%" : "60%",
    IMG_MAX_W: isTall ? "80%" : isWide ? "40%" : "65%",
    // Brand logo — slightly bigger
    BL_T: scale(3), BL_L: scale(3.5),
    BL_H: scale(4), BL_W: scale(14),
    // Prices — BIGGER, positioned better
    PR_L: scale(3.5), PR_B: isTall ? scale(12) : scale(10),
    PR_SALE_SIZE: scale(8), PR_ORIG_SIZE: scale(2.8), PR_DISC_SIZE: scale(2.8),
    // Categories — BIGGER
    CAT_SIZE: isTall ? scale(4.5) : isWide ? scale(3.5) : scale(4),
    // Trustpilot — bigger
    TP_B: scale(3.5), TP_R: scale(3.5),
    TP_STAR: scale(3), TP_NAME: scale(2.5), TP_BOX: scale(3.5), TP_ICON: scale(2.5), TP_SUB: scale(1.6),
    // Timing
    INTRO_MS: String(INTRO_MS), PROD_MS: String(PROD_MS), OUTRO_MS: String(OUTRO_MS),
    SEV_LOGO,
  };
}

// --- API helpers ---
async function api(path) {
  const r = await fetch(`${ADMIN_URL}${path}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  if (!r.ok) throw new Error(`API ${r.status}: ${path}`);
  return (await r.json()).data;
}

async function shopifyProducts(handle, limit) {
  const r = await fetch(`https://www.shoppingeventvip.com/collections/${handle}/products.json?limit=${limit * 2}`);
  if (!r.ok) throw new Error(`Shopify ${r.status}`);
  const d = await r.json();
  return d.products
    .filter(p => p.variants?.[0]?.compare_at_price)
    .slice(0, limit)
    .map(p => {
      const v = p.variants[0];
      const price = parseFloat(v.compare_at_price || v.price);
      const sale = parseFloat(v.price);
      const disc = price > 0 ? Math.round((1 - sale / price) * 100) : 0;
      return { title: p.title, image: p.images?.[0]?.src || "", price, sale, disc };
    })
    .sort((a, b) => b.disc - a.disc);
}

// --- Background removal ---
async function removeBg(imageUrl, outputPath) {
  try {
    await access(outputPath);
    console.log(`    ♻ cached: ${outputPath.split("/").pop()}`);
    return outputPath; // already processed
  } catch {}

  console.log(`    ✂ removing bg: ${imageUrl.split("/").pop().slice(0, 40)}...`);
  try {
    execSync(
      `python3 "${join(__dirname, "remove-bg.py")}" "${imageUrl}" "${outputPath}"`,
      { stdio: "pipe", timeout: 60000 }
    );
    return outputPath;
  } catch (e) {
    console.log(`    ⚠ bg removal failed, using original`);
    return imageUrl; // fallback to original
  }
}

// --- Fetch sale data ---
async function fetchSale(eventId) {
  console.log("Fetching event...");
  const ev = await api(
    `/items/event/${eventId}?fields=id,start_date,expiration_date,url,` +
    `event_translations.title,event_translations.date,event_translations.languages_id,` +
    `brands.brand_id.name,brands.brand_id.logo_black`
  );

  const nlT = ev.event_translations?.find(t => t.languages_id === "nl-NL") || ev.event_translations?.[0];
  const frT = ev.event_translations?.find(t => t.languages_id === "fr-FR");
  const brand = ev.brands?.[0]?.brand_id;
  const brandName = brand?.name || "Brand";
  const brandLogo = brand?.logo_black ? `${ADMIN_URL}/assets/${brand.logo_black}` : "";

  const handle = ev.url?.split("/collections/")?.[1]?.split("?")?.[0] || brandName.toLowerCase().replace(/\s+/g, "-");
  console.log(`  ${nlT?.title} — ${brandName} — collection: ${handle}`);

  console.log("Fetching products...");
  const prods = await shopifyProducts(handle, MAX_PRODUCTS);
  console.log(`  ${prods.length} products found`);

  const expires = new Date(ev.expiration_date);
  const daysLeft = Math.max(0, Math.ceil((expires - new Date()) / 86400000));
  const maxDisc = prods.length ? Math.max(...prods.map(p => p.disc)) : 0;

  let urgNl, urgFr;
  if (daysLeft <= 1) { urgNl = "LAATSTE KANS!"; urgFr = "DERNIÈRE CHANCE!"; }
  else if (daysLeft <= 3) { urgNl = `NOG ${daysLeft} DAGEN!`; urgFr = `PLUS QUE ${daysLeft} JOURS!`; }
  else { urgNl = (nlT?.date || "").toUpperCase(); urgFr = (frT?.date || "").toUpperCase(); }

  return {
    brandName, brandLogo, prods,
    tagNl: `${brandName.toUpperCase()}: TOT -${maxDisc}%\n${urgNl}`,
    tagFr: `${brandName.toUpperCase()}: JUSQU'À -${maxDisc}%\n${urgFr}`,
  };
}

// --- Build HTML ---
function buildHtml(template, sale, lang, w, h, bgRemovedPaths) {
  let html = template;
  const tokens = getTokens(w, h);

  // Disable autoplay
  html = html.replace("window._auto=true;", "window._auto=false;");

  // Inject tokens
  for (const [k, v] of Object.entries(tokens)) html = html.replaceAll(`{{${k}}}`, v);

  // Tagline
  const tag = lang === "fr" ? sale.tagFr : sale.tagNl;
  html = html.replace("{{TAGLINE}}", tag.replace("\n", "<br>"));

  // Slides
  let slides = "";
  sale.prods.forEach((p, i) => {
    const imgSrc = bgRemovedPaths[i] || p.image;
    slides += `
    <div class="slide">
      <img class="prod-img" src="${imgSrc}" alt="" />
      ${sale.brandLogo ? `<img class="brand-logo" src="${sale.brandLogo}" alt="" />` : ""}
      <div class="prices">
        <div class="sale">€${p.sale.toFixed(2)}</div>
        <div class="meta">
          <span class="orig">€${p.price.toFixed(2)}</span>
          <span class="disc">-${p.disc}%</span>
        </div>
      </div>
    </div>`;
  });
  html = html.replace("{{SLIDES}}", slides);

  // Categories
  const catsNl = ["KLEDING", "MEUBELS EN DECO", "ACCESSOIRES", "JUWELEN"];
  const catsFr = ["VÊTEMENTS", "MEUBLES ET DÉCO", "ACCESSOIRES", "BIJOUX"];
  const lastNl = "EN NOG VEEL <b>MEER</b>";
  const lastFr = "ET BIEN <b>PLUS ENCORE</b>";
  const cats = (lang === "fr" ? catsFr : catsNl).map(c => `<li>${c}</li>`).join("")
    + `<li class="it">${lang === "fr" ? lastFr : lastNl}</li>`;
  html = html.replace("{{CATS}}", cats);

  const totalMs = INTRO_MS + sale.prods.length * PROD_MS + OUTRO_MS;
  return { html, totalMs };
}

// --- Render video ---
async function render(html, totalMs, w, h, outPath) {
  const frDir = outPath.replace(".mp4", "-frames");
  await mkdir(frDir, { recursive: true });
  const totalFrames = Math.ceil(FPS * totalMs / 1000);

  // Use lower deviceScaleFactor for large formats to avoid memory issues
  const dpr = Math.max(w, h) > 1080 ? 1 : 2;

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);

  process.stdout.write(`  Capturing ${totalFrames} frames...`);
  const dt = 1000 / FPS;
  for (let i = 0; i < totalFrames; i++) {
    await page.evaluate(ms => window.setTime(ms), i * dt);
    await new Promise(r => setTimeout(r, 35));
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
  console.log(`  ✓ ${outPath}`);
}

// --- Main ---
async function main() {
  const eventId = process.argv[2] || "6cbcb809-633c-4031-99ec-5c87f3d652d4";
  const sale = await fetchSale(eventId);

  // Only render one format for testing speed — pass "all" as 3rd arg for all formats
  const renderAll = process.argv[3] === "all";
  const formats = renderAll
    ? Object.entries(FORMATS)
    : [["4x5", FORMATS["4x5"]]]; // Default: 4:5 (best Meta performer)

  const template = await readFile(
    join(__dirname, "templates", "banners", "sev-video-ad.html"), "utf-8"
  );

  const outDir = join(__dirname, "output", "video-ads");
  const bgDir = join(outDir, "bg-removed");
  await mkdir(bgDir, { recursive: true });

  // Remove backgrounds — serve via local HTTP server
  console.log("\nRemoving backgrounds...");
  const bgLocalPaths = [];
  for (let i = 0; i < sale.prods.length; i++) {
    const outPath = join(bgDir, `product-${i}.png`);
    const result = await removeBg(sale.prods[i].image, outPath);
    bgLocalPaths.push(result);
  }

  // Start local HTTP server for bg-removed images
  const IMG_PORT = 9123;
  const imgServer = createServer((req, res) => {
    const decodedUrl = decodeURIComponent(req.url).replace(/^\//, "");
    // Reject path traversal attempts
    if (decodedUrl.includes("..") || decodedUrl.startsWith("/")) {
      res.writeHead(400); res.end("Invalid path"); return;
    }
    const filePath = join(bgDir, decodedUrl);
    // Ensure resolved path stays within bgDir
    const resolvedPath = resolve(filePath);
    const resolvedBgDir = resolve(bgDir);
    if (!resolvedPath.startsWith(resolvedBgDir)) {
      res.writeHead(400); res.end("Invalid path"); return;
    }
    if (existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "image/png" });
      createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
  });
  imgServer.listen(IMG_PORT);

  const bgPaths = bgLocalPaths.map((p, i) =>
    p.startsWith("http") ? p : `http://localhost:${IMG_PORT}/product-${i}.png`
  );
  console.log(`  Local image server on port ${IMG_PORT}`);

  const slug = sale.brandName.toLowerCase().replace(/\s+/g, "-");

  for (const [fmtKey, fmt] of formats) {
    for (const lang of ["nl", "fr"]) {
      console.log(`\n[${fmtKey}] ${fmt.label} — ${lang.toUpperCase()}`);
      const { html, totalMs } = buildHtml(template, sale, lang, fmt.w, fmt.h, bgPaths);

      const outPath = join(outDir, `${slug}-${fmtKey}-${lang}.mp4`);
      const htmlPath = join(outDir, `debug-${fmtKey}-${lang}.html`);
      await writeFile(htmlPath, html);
      await render(html, totalMs, fmt.w, fmt.h, outPath);
    }
  }

  imgServer.close();
  console.log("\nAll done!");
}

main().catch(console.error);
