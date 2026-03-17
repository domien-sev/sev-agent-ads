import type { AdsAgent } from "../agent.js";
import type { AdProductRecord } from "@domien-sev/shared-types";
import { getClient, createItem, updateItem, readItems } from "../lib/directus.js";

/**
 * Product ingestion pipeline — syncs products from Shopify to ad_products.
 * Uses `media` connection (NOT deprecated `image` field).
 */
export async function syncProducts(agent: AdsAgent, options?: { limit?: number }): Promise<AdProductRecord[]> {
  const client = getClient(agent);
  const limit = options?.limit ?? 50;

  agent.log.info(`Syncing up to ${limit} products from Shopify...`);

  // Fetch products from Shopify (uses media connection)
  const shopifyProducts = await agent.shopifyClient.graphql(`{
    products(first: ${limit}) {
      edges {
        node {
          id
          handle
          title
          descriptionHtml
          vendor
          productType
          status
          tags
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          compareAtPriceRange {
            minVariantCompareAtPrice { amount currencyCode }
          }
          media(first: 10) {
            edges {
              node {
                ... on MediaImage {
                  image { url altText }
                }
              }
            }
          }
          metafields(first: 10, keys: ["custom.brand", "custom.season", "custom.color", "custom.material", "custom.gender"]) {
            edges {
              node { key value }
            }
          }
        }
      }
    }
  }`);

  const products: AdProductRecord[] = [];

  for (const edge of shopifyProducts.data?.products?.edges ?? []) {
    const node = edge.node;
    const shopifyId = node.id.replace("gid://shopify/Product/", "");

    const price = parseFloat(node.priceRangeV2?.minVariantPrice?.amount ?? "0");
    const compareAt = parseFloat(node.compareAtPriceRange?.minVariantCompareAtPrice?.amount ?? "0");
    const discountPercent = compareAt > 0 ? Math.round(((compareAt - price) / compareAt) * 100) : null;

    const images = (node.media?.edges ?? [])
      .map((e: { node: { image?: { url: string } } }) => e.node.image?.url)
      .filter(Boolean) as string[];

    const metafields = new Map(
      (node.metafields?.edges ?? []).map((e: { node: { key: string; value: string } }) => [e.node.key, e.node.value]),
    );

    const record: AdProductRecord = {
      shopify_id: shopifyId,
      handle: node.handle,
      title: node.title,
      description: node.descriptionHtml ?? null,
      images,
      price,
      compare_at_price: compareAt > 0 ? compareAt : null,
      discount_percent: discountPercent,
      vendor: node.vendor ?? null,
      product_type: node.productType ?? null,
      tags: node.tags ?? [],
      brand: metafields.get("custom.brand") ?? node.vendor ?? null,
      season: metafields.get("custom.season") ?? null,
      color: metafields.get("custom.color") ?? null,
      material: metafields.get("custom.material") ?? null,
      gender: (metafields.get("custom.gender") as AdProductRecord["gender"]) ?? null,
      category: node.productType ?? null,
      status: node.status?.toLowerCase() === "active" ? "active" : "draft",
      priority: discountPercent && discountPercent >= 50 ? "hero" : "standard",
      last_synced: new Date().toISOString(),
    };

    // Upsert into Directus
    const existing = await client.request(
      readItems("ad_products", { filter: { shopify_id: { _eq: shopifyId } }, limit: 1 }),
    );

    if (existing.length > 0) {
      await client.request(updateItem("ad_products", existing[0].id!, record));
      record.id = existing[0].id;
    } else {
      const created = await client.request(createItem("ad_products", record));
      record.id = (created as { id: string }).id;
    }

    products.push(record);
  }

  agent.log.info(`Synced ${products.length} products to ad_products`);
  return products;
}

/** Sync a single product by Shopify ID (webhook trigger) */
export async function syncSingleProduct(agent: AdsAgent, shopifyId: string): Promise<AdProductRecord | null> {
  const products = await syncProducts(agent, { limit: 1 });
  return products.find((p) => p.shopify_id === shopifyId) ?? null;
}
