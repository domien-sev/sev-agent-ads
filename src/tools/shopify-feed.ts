import type { AdsAgent } from "../agent.js";
import type { AdProductRecord } from "@domien-sev/shared-types";
import { readItems } from "@directus/sdk";

/**
 * Product feed utilities for Google Merchant API and Meta Product Catalog.
 * Uses Merchant API (NOT Content API — sunsets Aug 18, 2026).
 */

/** Generate a Google Merchant-compatible product feed */
export async function generateGoogleFeed(agent: AdsAgent): Promise<MerchantProduct[]> {
  const client = agent.directus.getClient("sev-ai") as any;

  const products = await client.request(
    readItems("ad_products", {
      filter: { status: { _eq: "active" } },
    }),
  ) as AdProductRecord[];

  return products.map((p) => ({
    offerId: p.shopify_id,
    title: p.title,
    description: p.description ?? p.title,
    link: `https://${process.env.SHOPIFY_SHOP}/products/${p.handle}`,
    imageLink: p.images[0] ?? "",
    additionalImageLinks: p.images.slice(1),
    price: { value: String(p.price), currency: "EUR" },
    ...(p.compare_at_price && {
      salePrice: { value: String(p.price), currency: "EUR" },
    }),
    brand: p.brand ?? p.vendor ?? "",
    condition: "new",
    availability: "in_stock",
    googleProductCategory: mapToGoogleCategory(p.category),
    productType: p.product_type ?? p.category ?? "",
    gender: p.gender ?? "unisex",
    color: p.color ?? "",
    material: p.material ?? "",
  }));
}

/** Generate a Meta Commerce-compatible product feed */
export async function generateMetaFeed(agent: AdsAgent): Promise<MetaCatalogProduct[]> {
  const client = agent.directus.getClient("sev-ai") as any;

  const products = await client.request(
    readItems("ad_products", {
      filter: { status: { _eq: "active" } },
    }),
  ) as AdProductRecord[];

  return products.map((p) => ({
    id: p.shopify_id,
    title: p.title,
    description: p.description ?? p.title,
    availability: "in stock",
    condition: "new",
    price: `${p.price} EUR`,
    link: `https://${process.env.SHOPIFY_SHOP}/products/${p.handle}`,
    image_link: p.images[0] ?? "",
    brand: p.brand ?? p.vendor ?? "",
    google_product_category: mapToGoogleCategory(p.category),
    ...(p.compare_at_price && { sale_price: `${p.price} EUR` }),
  }));
}

function mapToGoogleCategory(category: string | null): string {
  // Basic mapping — extend with full taxonomy as needed
  const map: Record<string, string> = {
    shoes: "Apparel & Accessories > Shoes",
    clothing: "Apparel & Accessories > Clothing",
    accessories: "Apparel & Accessories > Clothing Accessories",
    bags: "Apparel & Accessories > Handbags, Wallets & Cases",
    jewelry: "Apparel & Accessories > Jewelry",
  };
  return map[category?.toLowerCase() ?? ""] ?? "Apparel & Accessories";
}

interface MerchantProduct {
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: string[];
  price: { value: string; currency: string };
  salePrice?: { value: string; currency: string };
  brand: string;
  condition: string;
  availability: string;
  googleProductCategory: string;
  productType: string;
  gender: string;
  color: string;
  material: string;
}

interface MetaCatalogProduct {
  id: string;
  title: string;
  description: string;
  availability: string;
  condition: string;
  price: string;
  link: string;
  image_link: string;
  brand: string;
  google_product_category: string;
  sale_price?: string;
}
