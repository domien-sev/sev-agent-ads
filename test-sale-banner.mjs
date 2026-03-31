/**
 * Sale-driven animated banner — pulls event + products from admin.shoppingeventvip.be
 * Usage: node test-sale-banner.mjs [event-id]
 * Default: uses latest Timberland sale
 */
import puppeteer from "puppeteer";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const ADMIN_URL = "https://admin.shoppingeventvip.be";
const ADMIN_TOKEN = "xMyXxqn8O9zIaM8n2PqrqwSjQgv_oJrr";
const SEV_LOGO_URL = "https://www.shoppingeventvip.com/cdn/shop/files/logo_1.png?v=1667984101";

const WIDTH = 300;
const HEIGHT = 250;
const FPS = 30;
const INTRO_HOLD = 3000;
const PRODUCT_DURATION = 3500;
const OUTRO_HOLD = 4000;
const MAX_PRODUCTS = 6;

// --- Directus API helpers ---
async function fetchJson(path) {
  const res = await fetch(`${ADMIN_URL}${path}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return (await res.json()).data;
}

// --- Fetch Shopify products from a collection ---
async function fetchShopifyProducts(collectionHandle, limit = 6) {
  const url = `https://www.shoppingeventvip.com/collections/${collectionHandle}/products.json?limit=${limit * 2}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${url}`);
  const data = await res.json();

  return data.products
    .filter(p => p.variants?.[0]?.compare_at_price) // only discounted
    .slice(0, limit)
    .map(p => {
      const variant = p.variants[0];
      const price = parseFloat(variant.compare_at_price || variant.price);
      const salePrice = parseFloat(variant.price);
      const discount = price > 0 ? Math.round((1 - salePrice / price) * 100) : 0;
      const image = p.images?.[0]?.src || "";

      return {
        title: p.title,
        image,
        price,
        salePrice,
        discount,
      };
    })
    .sort((a, b) => b.discount - a.discount); // highest discount first
}

// --- Fetch sale data ---
async function fetchSaleData(eventId) {
  console.log(`Fetching event ${eventId}...`);

  const event = await fetchJson(
    `/items/event/${eventId}?fields=id,status,type,start_date,expiration_date,url,` +
    `event_translations.title,event_translations.date,event_translations.languages_id,` +
    `brands.brand_id.id,brands.brand_id.name,brands.brand_id.logo_black`
  );

  // Get NL translation (primary)
  const nlTrans = event.event_translations?.find(t => t.languages_id === "nl-NL") || event.event_translations?.[0];
  const frTrans = event.event_translations?.find(t => t.languages_id === "fr-FR");

  // Get brand info
  const brand = event.brands?.[0]?.brand_id;
  const brandName = brand?.name || "Unknown";
  const brandLogoUrl = brand?.logo_black ? `${ADMIN_URL}/assets/${brand.logo_black}` : "";

  console.log(`  Sale: ${nlTrans?.title} (${brandName})`);
  console.log(`  Dates: ${event.start_date} → ${event.expiration_date}`);
  console.log(`  Date text NL: ${nlTrans?.date} | FR: ${frTrans?.date}`);

  // Fetch products from Shopify via the event's collection URL
  const collectionHandle = event.url?.split("/collections/")?.[1]?.split("?")?.[0] || brandName.toLowerCase().replace(/\s+/g, "-");
  console.log(`Fetching Shopify products from collection "${collectionHandle}"...`);
  const products = await fetchShopifyProducts(collectionHandle, MAX_PRODUCTS);
  console.log(`  Found ${products.length} products`);

  // Calculate urgency
  const expiresAt = new Date(event.expiration_date);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)));

  // Build urgency text
  let urgencyNl, urgencyFr;
  if (daysLeft <= 0) {
    urgencyNl = "LAATSTE KANS!";
    urgencyFr = "DERNIÈRE CHANCE!";
  } else if (daysLeft === 1) {
    urgencyNl = "NOG 1 DAG!";
    urgencyFr = "PLUS QU'1 JOUR!";
  } else if (daysLeft <= 3) {
    urgencyNl = `NOG ${daysLeft} DAGEN!`;
    urgencyFr = `PLUS QUE ${daysLeft} JOURS!`;
  } else {
    urgencyNl = nlTrans?.date?.toUpperCase() || "";
    urgencyFr = frTrans?.date?.toUpperCase() || "";
  }

  // Find max discount
  const maxDiscount = products.length > 0 ? Math.max(...products.map(p => p.discount)) : 0;

  // Build tagline
  const taglineNl = `${brandName.toUpperCase()}: TOT -${maxDiscount}% — ${urgencyNl}`;
  const taglineFr = `${brandName.toUpperCase()}: JUSQU'À -${maxDiscount}% — ${urgencyFr}`;

  return {
    event,
    brandName,
    brandLogoUrl,
    taglineNl,
    taglineFr,
    urgencyNl,
    urgencyFr,
    daysLeft,
    maxDiscount,
    products: products.map(p => ({
      image: p.image,
      brandLogo: brandLogoUrl,
      priceSale: `€${p.salePrice.toFixed(2)}`,
      priceOriginal: `€${p.price.toFixed(2)}`,
      discountPct: p.discount,
      title: p.title,
    })),
  };
}

// --- Build HTML ---
function buildHtml(templateHtml, saleData, lang = "nl") {
  let html = templateHtml;

  const tagline = lang === "fr" ? saleData.taglineFr : saleData.taglineNl;
  const totalMs = INTRO_HOLD + saleData.products.length * PRODUCT_DURATION + OUTRO_HOLD;

  const TOKENS = {
    WIDTH: String(WIDTH), HEIGHT: String(HEIGHT),
    TAGLINE_SIZE: "20px",
    CTA_SIZE: "11px", CTA_PADDING: "7px 14px",
    CTA_SMALL_SIZE: "10px", CTA_SMALL_PAD: "6px 12px",
    SMALL_LOGO_W: "22%",
    BRAND_LOGO_H: "18px", BRAND_LOGO_W: "55px",
    PRICE_SALE_SIZE: "30px", PRICE_ORIG_SIZE: "11px", PRICE_DISC_SIZE: "11px",
    CAT_SIZE: "15px",
    TP_STAR_SIZE: "12px", TP_NAME_SIZE: "10px",
    TP_BOX_SIZE: "15px", TP_BOX_FONT: "10px", TP_SUB_SIZE: "7px",
    SEV_LOGO_URL,
    INTRO_HOLD_MS: String(INTRO_HOLD),
    PRODUCT_DURATION_MS: String(PRODUCT_DURATION),
    OUTRO_HOLD_MS: String(OUTRO_HOLD),
  };

  for (const [key, value] of Object.entries(TOKENS)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }

  // Disable autoplay for Puppeteer control
  html = html.replace("window._autoplay = true;", "window._autoplay = false;");

  // Tagline
  html = html.replace("{{TAGLINE}}", tagline);

  // Product slides
  let slides = "";
  for (const p of saleData.products) {
    slides += `
    <div class="slide">
      <img class="product-img" src="${p.image}" alt="" />
      <img class="brand-logo" src="${p.brandLogo}" alt="" />
      <div class="price-block">
        <div class="price-sale">${p.priceSale}</div>
        <div class="price-original">${p.priceOriginal}</div>
        <div class="price-discount">-${p.discountPct}%</div>
      </div>
    </div>`;
  }
  html = html.replace("{{PRODUCT_SLIDES}}", slides);

  // Categories
  const categories = lang === "fr"
    ? ["VÊTEMENTS", "MEUBLES ET DÉCO", "ACCESSOIRES", "BIJOUX"]
    : ["KLEDING", "MEUBELS EN DECO", "ACCESSOIRES", "JUWELEN"];
  const lastCat = lang === "fr" ? "ET BIEN <b>PLUS ENCORE</b>" : "EN NOG VEEL <b>MEER</b>";

  const catHtml = categories.map(c => `<li>${c}</li>`).join("\n      ")
    + `\n      <li class="last-cat">${lastCat}</li>`;
  html = html.replace("{{CATEGORY_LIST}}", catHtml);

  return { html, totalMs };
}

// --- Render to video ---
async function renderVideo(html, totalMs, outputPath) {
  const framesDir = join(dirname(outputPath), "sale-frames");
  await mkdir(framesDir, { recursive: true });

  const totalFrames = Math.ceil(FPS * totalMs / 1000);
  console.log(`Rendering ${totalFrames} frames (${(totalMs / 1000).toFixed(1)}s)...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);

  const frameDurationMs = 1000 / FPS;

  for (let i = 0; i < totalFrames; i++) {
    const timeMs = i * frameDurationMs;
    await page.evaluate((ms) => window.setTime(ms), timeMs);
    await new Promise(r => setTimeout(r, 40)); // let CSS transitions settle

    const buf = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    await writeFile(join(framesDir, `frame-${String(i).padStart(5, "0")}.png`), buf);

    if (i % (FPS * 3) === 0) process.stdout.write(`  ${(timeMs / 1000).toFixed(0)}s`);
  }

  console.log("\n  Encoding MP4...");
  await browser.close();

  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${join(framesDir, "frame-%05d.png")}" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset fast "${outputPath}"`,
    { stdio: "pipe" }
  );

  console.log(`  ✓ ${outputPath}`);
  return outputPath;
}

// --- Main ---
async function main() {
  // Default: Timberland sale
  const eventId = process.argv[2] || "6cbcb809-633c-4031-99ec-5c87f3d652d4";

  const saleData = await fetchSaleData(eventId);

  console.log(`\nSale banner for: ${saleData.brandName}`);
  console.log(`  Tagline NL: ${saleData.taglineNl}`);
  console.log(`  Tagline FR: ${saleData.taglineFr}`);
  console.log(`  Products: ${saleData.products.length}`);
  console.log(`  Days left: ${saleData.daysLeft}`);
  console.log();

  const templateHtml = await readFile(
    join(__dirname, "templates", "banners", "sev-animated-v3.html"), "utf-8"
  );

  const outDir = join(__dirname, "output", "banners");
  await mkdir(outDir, { recursive: true });

  // Render NL version
  const { html: htmlNl, totalMs: totalMsNl } = buildHtml(templateHtml, saleData, "nl");
  await writeFile(join(outDir, "debug-sale-nl.html"), htmlNl);
  await renderVideo(htmlNl, totalMsNl, join(outDir, `sale-${saleData.brandName.toLowerCase().replace(/\s+/g, "-")}-nl.mp4`));

  // Render FR version
  const { html: htmlFr, totalMs: totalMsFr } = buildHtml(templateHtml, saleData, "fr");
  await writeFile(join(outDir, "debug-sale-fr.html"), htmlFr);
  await renderVideo(htmlFr, totalMsFr, join(outDir, `sale-${saleData.brandName.toLowerCase().replace(/\s+/g, "-")}-fr.mp4`));

  console.log("\nDone! Both NL and FR versions rendered.");
}

main().catch(console.error);
