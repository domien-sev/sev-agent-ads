/**
 * Test script — renders all 13 banner sizes for the Timberland Scar Ridge Parka.
 * Run: node test-banner.mjs
 * Output: output/banners/*.png
 */
import puppeteer from "puppeteer";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BANNER_SIZES = {
  "120x600": { width: 120, height: 600, layout: "120x600" },
  "160x600": { width: 160, height: 600, layout: "160x600" },
  "200x200": { width: 200, height: 200, layout: "square" },
  "250x250": { width: 250, height: 250, layout: "square" },
  "300x250": { width: 300, height: 250, layout: "300x250" },
  "300x600": { width: 300, height: 600, layout: "300x600" },
  "320x100": { width: 320, height: 100, layout: "320x100" },
  "336x280": { width: 336, height: 280, layout: "square" },
  "468x60":  { width: 468, height: 60,  layout: "slim-h" },
  "728x90":  { width: 728, height: 90,  layout: "728x90" },
  "930x180": { width: 930, height: 180, layout: "wide" },
  "970x250": { width: 970, height: 250, layout: "970x250" },
  "970x90":  { width: 970, height: 90,  layout: "wide" },
};

const LAYOUT_TOKENS = {
  "300x250": { PANEL_PADDING: "16px", BRAND_FONT_SIZE: "9px", HEADLINE_FONT_SIZE: "16px", HEADLINE_MARGIN: "4px 0", PRICE_GAP: "6px", PRICE_MARGIN_TOP: "4px", PRICE_ORIGINAL_SIZE: "11px", PRICE_SALE_SIZE: "16px", BADGE_FONT_SIZE: "11px", BADGE_SIZE: "36px", CTA_FONT_SIZE: "9px", CTA_PADDING: "5px 12px", CTA_MARGIN_TOP: "6px", LOGO_FONT_SIZE: "12px", TRUST_FONT_SIZE: "10px", TRUST_LABEL_SIZE: "7px" },
  "728x90": { PANEL_PADDING: "8px 16px", BRAND_FONT_SIZE: "8px", HEADLINE_FONT_SIZE: "14px", HEADLINE_MARGIN: "2px 0", PRICE_GAP: "6px", PRICE_MARGIN_TOP: "2px", PRICE_ORIGINAL_SIZE: "10px", PRICE_SALE_SIZE: "14px", BADGE_FONT_SIZE: "9px", BADGE_SIZE: "28px", CTA_FONT_SIZE: "9px", CTA_PADDING: "5px 14px", CTA_MARGIN_TOP: "0", LOGO_FONT_SIZE: "11px", TRUST_FONT_SIZE: "9px", TRUST_LABEL_SIZE: "6px" },
  "160x600": { PANEL_PADDING: "12px", BRAND_FONT_SIZE: "8px", HEADLINE_FONT_SIZE: "14px", HEADLINE_MARGIN: "4px 0", PRICE_GAP: "4px", PRICE_MARGIN_TOP: "4px", PRICE_ORIGINAL_SIZE: "10px", PRICE_SALE_SIZE: "14px", BADGE_FONT_SIZE: "10px", BADGE_SIZE: "32px", CTA_FONT_SIZE: "8px", CTA_PADDING: "4px 10px", CTA_MARGIN_TOP: "8px", LOGO_FONT_SIZE: "10px", TRUST_FONT_SIZE: "9px", TRUST_LABEL_SIZE: "6px" },
  "970x250": { PANEL_PADDING: "20px 28px", BRAND_FONT_SIZE: "10px", HEADLINE_FONT_SIZE: "22px", HEADLINE_MARGIN: "6px 0", PRICE_GAP: "8px", PRICE_MARGIN_TOP: "4px", PRICE_ORIGINAL_SIZE: "13px", PRICE_SALE_SIZE: "20px", BADGE_FONT_SIZE: "13px", BADGE_SIZE: "44px", CTA_FONT_SIZE: "11px", CTA_PADDING: "7px 18px", CTA_MARGIN_TOP: "0", LOGO_FONT_SIZE: "14px", TRUST_FONT_SIZE: "11px", TRUST_LABEL_SIZE: "8px" },
  "300x600": { PANEL_PADDING: "16px", BRAND_FONT_SIZE: "9px", HEADLINE_FONT_SIZE: "18px", HEADLINE_MARGIN: "6px 0", PRICE_GAP: "6px", PRICE_MARGIN_TOP: "6px", PRICE_ORIGINAL_SIZE: "12px", PRICE_SALE_SIZE: "18px", BADGE_FONT_SIZE: "12px", BADGE_SIZE: "40px", CTA_FONT_SIZE: "10px", CTA_PADDING: "6px 16px", CTA_MARGIN_TOP: "10px", LOGO_FONT_SIZE: "12px", TRUST_FONT_SIZE: "10px", TRUST_LABEL_SIZE: "7px" },
  "320x100": { PANEL_PADDING: "6px 10px", BRAND_FONT_SIZE: "7px", HEADLINE_FONT_SIZE: "12px", HEADLINE_MARGIN: "1px 0", PRICE_GAP: "4px", PRICE_MARGIN_TOP: "1px", PRICE_ORIGINAL_SIZE: "9px", PRICE_SALE_SIZE: "12px", BADGE_FONT_SIZE: "8px", BADGE_SIZE: "24px", CTA_FONT_SIZE: "8px", CTA_PADDING: "3px 8px", CTA_MARGIN_TOP: "0", LOGO_FONT_SIZE: "9px", TRUST_FONT_SIZE: "8px", TRUST_LABEL_SIZE: "6px" },
  square: { PANEL_PADDING: "10px", BRAND_FONT_SIZE: "8px", HEADLINE_FONT_SIZE: "14px", HEADLINE_MARGIN: "3px 0", PRICE_GAP: "4px", PRICE_MARGIN_TOP: "3px", PRICE_ORIGINAL_SIZE: "10px", PRICE_SALE_SIZE: "13px", BADGE_FONT_SIZE: "10px", BADGE_SIZE: "30px", CTA_FONT_SIZE: "8px", CTA_PADDING: "4px 10px", CTA_MARGIN_TOP: "4px", LOGO_FONT_SIZE: "10px", TRUST_FONT_SIZE: "9px", TRUST_LABEL_SIZE: "6px" },
  "slim-h": { PANEL_PADDING: "4px 10px", BRAND_FONT_SIZE: "7px", HEADLINE_FONT_SIZE: "11px", HEADLINE_MARGIN: "0", PRICE_GAP: "4px", PRICE_MARGIN_TOP: "0", PRICE_ORIGINAL_SIZE: "8px", PRICE_SALE_SIZE: "11px", BADGE_FONT_SIZE: "8px", BADGE_SIZE: "20px", CTA_FONT_SIZE: "7px", CTA_PADDING: "2px 6px", CTA_MARGIN_TOP: "0", LOGO_FONT_SIZE: "8px", TRUST_FONT_SIZE: "8px", TRUST_LABEL_SIZE: "6px" },
  wide: { PANEL_PADDING: "12px 20px", BRAND_FONT_SIZE: "9px", HEADLINE_FONT_SIZE: "16px", HEADLINE_MARGIN: "3px 0", PRICE_GAP: "6px", PRICE_MARGIN_TOP: "3px", PRICE_ORIGINAL_SIZE: "11px", PRICE_SALE_SIZE: "15px", BADGE_FONT_SIZE: "10px", BADGE_SIZE: "32px", CTA_FONT_SIZE: "9px", CTA_PADDING: "5px 12px", CTA_MARGIN_TOP: "0", LOGO_FONT_SIZE: "11px", TRUST_FONT_SIZE: "10px", TRUST_LABEL_SIZE: "7px" },
  "120x600": { PANEL_PADDING: "8px", BRAND_FONT_SIZE: "7px", HEADLINE_FONT_SIZE: "12px", HEADLINE_MARGIN: "4px 0", PRICE_GAP: "3px", PRICE_MARGIN_TOP: "4px", PRICE_ORIGINAL_SIZE: "9px", PRICE_SALE_SIZE: "12px", BADGE_FONT_SIZE: "9px", BADGE_SIZE: "28px", CTA_FONT_SIZE: "7px", CTA_PADDING: "3px 6px", CTA_MARGIN_TOP: "8px", LOGO_FONT_SIZE: "9px", TRUST_FONT_SIZE: "8px", TRUST_LABEL_SIZE: "6px" },
};

// Timberland Scar Ridge Parka — top scorer from creative-scorer
const TEST_DATA = {
  productImage: "https://shoppingeventvip.myshopify.com/cdn/shop/files/TB0A5XR5590_1.webp",
  productName: "Scar Ridge Parka",
  brandName: "TIMBERLAND",
  priceOriginal: "€380",
  priceSale: "€119",
  discountPct: 69,
  ctaText: "SHOP NU",
};

async function main() {
  const outDir = join(__dirname, "output", "banners");
  await mkdir(outDir, { recursive: true });

  const templateHtml = await readFile(join(__dirname, "templates", "banners", "sev-banner.html"), "utf-8");

  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const sizes = Object.entries(BANNER_SIZES);
  console.log(`Rendering ${sizes.length} banner sizes...`);

  for (const [name, spec] of sizes) {
    const tokens = LAYOUT_TOKENS[spec.layout] ?? LAYOUT_TOKENS["300x250"];

    let html = templateHtml;
    html = html.replaceAll("{{WIDTH}}", String(spec.width));
    html = html.replaceAll("{{HEIGHT}}", String(spec.height));
    html = html.replaceAll("{{LAYOUT}}", spec.layout);
    html = html.replaceAll("{{PRODUCT_IMAGE}}", TEST_DATA.productImage);
    html = html.replaceAll("{{PRODUCT_NAME}}", TEST_DATA.productName);
    html = html.replaceAll("{{BRAND_NAME}}", TEST_DATA.brandName);
    html = html.replaceAll("{{PRICE_ORIGINAL}}", TEST_DATA.priceOriginal);
    html = html.replaceAll("{{PRICE_SALE}}", TEST_DATA.priceSale);
    html = html.replaceAll("{{DISCOUNT_PCT}}", String(TEST_DATA.discountPct));
    html = html.replaceAll("{{CTA_TEXT}}", TEST_DATA.ctaText);

    for (const [key, value] of Object.entries(tokens)) {
      html = html.replaceAll(`{{${key}}}`, value);
    }

    const page = await browser.newPage();
    await page.setViewport({ width: spec.width, height: spec.height, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);

    const buffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: spec.width, height: spec.height },
    });

    const outPath = join(outDir, `sev-${name}.png`);
    await writeFile(outPath, buffer);
    console.log(`  ✓ ${name} → ${outPath}`);
    await page.close();
  }

  await browser.close();
  console.log(`\nDone! ${sizes.length} banners in ${outDir}`);
}

main().catch(console.error);
