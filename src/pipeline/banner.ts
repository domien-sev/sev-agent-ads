import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdsAgent } from "../agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** All 13 standard display ad sizes */
export const BANNER_SIZES = {
  "120x600": { width: 120, height: 600, layout: "120x600" },
  "160x600": { width: 160, height: 600, layout: "160x600" },
  "200x200": { width: 200, height: 200, layout: "square" },
  "250x250": { width: 250, height: 250, layout: "square" },
  "300x250": { width: 300, height: 250, layout: "300x250" },
  "300x600": { width: 300, height: 600, layout: "300x600" },
  "320x100": { width: 320, height: 100, layout: "320x100" },
  "336x280": { width: 336, height: 280, layout: "square" },
  "468x60": { width: 468, height: 60, layout: "slim-h" },
  "728x90": { width: 728, height: 90, layout: "728x90" },
  "930x180": { width: 930, height: 180, layout: "wide" },
  "970x250": { width: 970, height: 250, layout: "970x250" },
  "970x90": { width: 970, height: 90, layout: "wide" },
} as const;

export type BannerSize = keyof typeof BANNER_SIZES;

export interface BannerData {
  productImage: string;   // URL to product image
  productName: string;    // e.g. "Scar Ridge Parka"
  brandName: string;      // e.g. "TIMBERLAND"
  priceOriginal: string;  // e.g. "€380"
  priceSale: string;      // e.g. "€119"
  discountPct: number;    // e.g. 69
  ctaText: string;        // e.g. "SHOP NU" / "ACHETER"
}

export interface BannerResult {
  size: BannerSize;
  width: number;
  height: number;
  buffer: Buffer;
  format: "png";
}

/** Font sizes and spacing per layout category */
const LAYOUT_TOKENS: Record<string, Record<string, string>> = {
  "300x250": {
    PANEL_PADDING: "16px",
    BRAND_FONT_SIZE: "9px",
    HEADLINE_FONT_SIZE: "16px",
    HEADLINE_MARGIN: "4px 0",
    PRICE_GAP: "6px",
    PRICE_MARGIN_TOP: "4px",
    PRICE_ORIGINAL_SIZE: "11px",
    PRICE_SALE_SIZE: "16px",
    BADGE_FONT_SIZE: "11px",
    BADGE_SIZE: "36px",
    CTA_FONT_SIZE: "9px",
    CTA_PADDING: "5px 12px",
    CTA_MARGIN_TOP: "6px",
    LOGO_FONT_SIZE: "12px",
    TRUST_FONT_SIZE: "10px",
    TRUST_LABEL_SIZE: "7px",
  },
  "728x90": {
    PANEL_PADDING: "8px 16px",
    BRAND_FONT_SIZE: "8px",
    HEADLINE_FONT_SIZE: "14px",
    HEADLINE_MARGIN: "2px 0",
    PRICE_GAP: "6px",
    PRICE_MARGIN_TOP: "2px",
    PRICE_ORIGINAL_SIZE: "10px",
    PRICE_SALE_SIZE: "14px",
    BADGE_FONT_SIZE: "9px",
    BADGE_SIZE: "28px",
    CTA_FONT_SIZE: "9px",
    CTA_PADDING: "5px 14px",
    CTA_MARGIN_TOP: "0",
    LOGO_FONT_SIZE: "11px",
    TRUST_FONT_SIZE: "9px",
    TRUST_LABEL_SIZE: "6px",
  },
  "160x600": {
    PANEL_PADDING: "12px",
    BRAND_FONT_SIZE: "8px",
    HEADLINE_FONT_SIZE: "14px",
    HEADLINE_MARGIN: "4px 0",
    PRICE_GAP: "4px",
    PRICE_MARGIN_TOP: "4px",
    PRICE_ORIGINAL_SIZE: "10px",
    PRICE_SALE_SIZE: "14px",
    BADGE_FONT_SIZE: "10px",
    BADGE_SIZE: "32px",
    CTA_FONT_SIZE: "8px",
    CTA_PADDING: "4px 10px",
    CTA_MARGIN_TOP: "8px",
    LOGO_FONT_SIZE: "10px",
    TRUST_FONT_SIZE: "9px",
    TRUST_LABEL_SIZE: "6px",
  },
  "970x250": {
    PANEL_PADDING: "20px 28px",
    BRAND_FONT_SIZE: "10px",
    HEADLINE_FONT_SIZE: "22px",
    HEADLINE_MARGIN: "6px 0",
    PRICE_GAP: "8px",
    PRICE_MARGIN_TOP: "4px",
    PRICE_ORIGINAL_SIZE: "13px",
    PRICE_SALE_SIZE: "20px",
    BADGE_FONT_SIZE: "13px",
    BADGE_SIZE: "44px",
    CTA_FONT_SIZE: "11px",
    CTA_PADDING: "7px 18px",
    CTA_MARGIN_TOP: "0",
    LOGO_FONT_SIZE: "14px",
    TRUST_FONT_SIZE: "11px",
    TRUST_LABEL_SIZE: "8px",
  },
  "300x600": {
    PANEL_PADDING: "16px",
    BRAND_FONT_SIZE: "9px",
    HEADLINE_FONT_SIZE: "18px",
    HEADLINE_MARGIN: "6px 0",
    PRICE_GAP: "6px",
    PRICE_MARGIN_TOP: "6px",
    PRICE_ORIGINAL_SIZE: "12px",
    PRICE_SALE_SIZE: "18px",
    BADGE_FONT_SIZE: "12px",
    BADGE_SIZE: "40px",
    CTA_FONT_SIZE: "10px",
    CTA_PADDING: "6px 16px",
    CTA_MARGIN_TOP: "10px",
    LOGO_FONT_SIZE: "12px",
    TRUST_FONT_SIZE: "10px",
    TRUST_LABEL_SIZE: "7px",
  },
  "320x100": {
    PANEL_PADDING: "6px 10px",
    BRAND_FONT_SIZE: "7px",
    HEADLINE_FONT_SIZE: "12px",
    HEADLINE_MARGIN: "1px 0",
    PRICE_GAP: "4px",
    PRICE_MARGIN_TOP: "1px",
    PRICE_ORIGINAL_SIZE: "9px",
    PRICE_SALE_SIZE: "12px",
    BADGE_FONT_SIZE: "8px",
    BADGE_SIZE: "24px",
    CTA_FONT_SIZE: "8px",
    CTA_PADDING: "3px 8px",
    CTA_MARGIN_TOP: "0",
    LOGO_FONT_SIZE: "9px",
    TRUST_FONT_SIZE: "8px",
    TRUST_LABEL_SIZE: "6px",
  },
  square: {
    PANEL_PADDING: "10px",
    BRAND_FONT_SIZE: "8px",
    HEADLINE_FONT_SIZE: "14px",
    HEADLINE_MARGIN: "3px 0",
    PRICE_GAP: "4px",
    PRICE_MARGIN_TOP: "3px",
    PRICE_ORIGINAL_SIZE: "10px",
    PRICE_SALE_SIZE: "13px",
    BADGE_FONT_SIZE: "10px",
    BADGE_SIZE: "30px",
    CTA_FONT_SIZE: "8px",
    CTA_PADDING: "4px 10px",
    CTA_MARGIN_TOP: "4px",
    LOGO_FONT_SIZE: "10px",
    TRUST_FONT_SIZE: "9px",
    TRUST_LABEL_SIZE: "6px",
  },
  "slim-h": {
    PANEL_PADDING: "4px 10px",
    BRAND_FONT_SIZE: "7px",
    HEADLINE_FONT_SIZE: "11px",
    HEADLINE_MARGIN: "0",
    PRICE_GAP: "4px",
    PRICE_MARGIN_TOP: "0",
    PRICE_ORIGINAL_SIZE: "8px",
    PRICE_SALE_SIZE: "11px",
    BADGE_FONT_SIZE: "8px",
    BADGE_SIZE: "20px",
    CTA_FONT_SIZE: "7px",
    CTA_PADDING: "2px 6px",
    CTA_MARGIN_TOP: "0",
    LOGO_FONT_SIZE: "8px",
    TRUST_FONT_SIZE: "8px",
    TRUST_LABEL_SIZE: "6px",
  },
  wide: {
    PANEL_PADDING: "12px 20px",
    BRAND_FONT_SIZE: "9px",
    HEADLINE_FONT_SIZE: "16px",
    HEADLINE_MARGIN: "3px 0",
    PRICE_GAP: "6px",
    PRICE_MARGIN_TOP: "3px",
    PRICE_ORIGINAL_SIZE: "11px",
    PRICE_SALE_SIZE: "15px",
    BADGE_FONT_SIZE: "10px",
    BADGE_SIZE: "32px",
    CTA_FONT_SIZE: "9px",
    CTA_PADDING: "5px 12px",
    CTA_MARGIN_TOP: "0",
    LOGO_FONT_SIZE: "11px",
    TRUST_FONT_SIZE: "10px",
    TRUST_LABEL_SIZE: "7px",
  },
  "120x600": {
    PANEL_PADDING: "8px",
    BRAND_FONT_SIZE: "7px",
    HEADLINE_FONT_SIZE: "12px",
    HEADLINE_MARGIN: "4px 0",
    PRICE_GAP: "3px",
    PRICE_MARGIN_TOP: "4px",
    PRICE_ORIGINAL_SIZE: "9px",
    PRICE_SALE_SIZE: "12px",
    BADGE_FONT_SIZE: "9px",
    BADGE_SIZE: "28px",
    CTA_FONT_SIZE: "7px",
    CTA_PADDING: "3px 6px",
    CTA_MARGIN_TOP: "8px",
    LOGO_FONT_SIZE: "9px",
    TRUST_FONT_SIZE: "8px",
    TRUST_LABEL_SIZE: "6px",
  },
};

/** Load the HTML template and inject data + layout tokens */
function buildHtml(size: BannerSize, data: BannerData): string {
  const spec = BANNER_SIZES[size];
  const tokens = LAYOUT_TOKENS[spec.layout] ?? LAYOUT_TOKENS["300x250"];

  let html = templateHtml;

  // Inject size and layout
  html = html.replaceAll("{{WIDTH}}", String(spec.width));
  html = html.replaceAll("{{HEIGHT}}", String(spec.height));
  html = html.replaceAll("{{LAYOUT}}", spec.layout);

  // Inject data
  html = html.replaceAll("{{PRODUCT_IMAGE}}", data.productImage);
  html = html.replaceAll("{{PRODUCT_NAME}}", data.productName);
  html = html.replaceAll("{{BRAND_NAME}}", data.brandName);
  html = html.replaceAll("{{PRICE_ORIGINAL}}", data.priceOriginal);
  html = html.replaceAll("{{PRICE_SALE}}", data.priceSale);
  html = html.replaceAll("{{DISCOUNT_PCT}}", String(data.discountPct));
  html = html.replaceAll("{{CTA_TEXT}}", data.ctaText);

  // Inject layout tokens
  for (const [key, value] of Object.entries(tokens)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }

  return html;
}

let templateHtml = "";

/** Load the template from disk (once) */
async function loadTemplate(): Promise<void> {
  if (templateHtml) return;
  const templatePath = join(__dirname, "../../templates/banners/sev-banner.html");
  templateHtml = await readFile(templatePath, "utf-8");
}

/**
 * Render banners for a product across all requested sizes.
 * Returns PNG buffers ready for S3 upload.
 */
export async function renderBanners(
  agent: AdsAgent,
  data: BannerData,
  sizes?: BannerSize[],
): Promise<BannerResult[]> {
  // Dynamic import — puppeteer is heavy, only load when needed
  const puppeteer = await import("puppeteer");

  await loadTemplate();

  const targetSizes = sizes ?? (Object.keys(BANNER_SIZES) as BannerSize[]);
  const results: BannerResult[] = [];

  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    for (const size of targetSizes) {
      const spec = BANNER_SIZES[size];
      const html = buildHtml(size, data);

      const page = await browser.newPage();
      await page.setViewport({ width: spec.width, height: spec.height, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: "networkidle0" });

      // Wait for fonts to load
      await page.evaluate("document.fonts.ready");

      const buffer = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: spec.width, height: spec.height },
      });

      results.push({
        size,
        width: spec.width,
        height: spec.height,
        buffer: Buffer.from(buffer),
        format: "png",
      });

      await page.close();
    }
  } finally {
    await browser.close();
  }

  agent.log.info(`Rendered ${results.length} banners for "${data.productName}"`);
  return results;
}
