import type { AdsAgent } from "../agent.js";
import type { ApiRouter } from "./router.js";
import { getClient, readItems } from "../lib/directus.js";
import { syncProducts } from "../pipeline/ingest.js";

export function registerProductRoutes(router: ApiRouter, agent: AdsAgent) {
  /**
   * GET /api/products?brand=X&query=X&status=active&limit=50&offset=0
   * List products from ad_products with optional filters.
   */
  router.get("/api/products", async (req) => {
    const { brand, query, status, limit: limitStr, offset: offsetStr } = req.query;
    const limit = Math.min(parseInt(limitStr || "50", 10), 100);
    const offset = parseInt(offsetStr || "0", 10);

    const filter: Record<string, unknown> = {};
    if (status) filter.status = { _eq: status };
    if (brand) filter.brand = { _icontains: brand };

    if (query) {
      filter._or = [
        { title: { _icontains: query } },
        { handle: { _icontains: query } },
        { brand: { _icontains: query } },
        { vendor: { _icontains: query } },
      ];
    }

    const client = getClient(agent);
    const products = await client.request(
      readItems("ad_products", {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        limit,
        offset,
      }),
    );

    return { status: 200, data: { items: products, limit, offset } };
  });

  /**
   * POST /api/products/sync
   * Body: { limit?: number }
   * Trigger Shopify → ad_products sync.
   */
  router.post("/api/products/sync", async (req) => {
    const { limit } = (req.body as { limit?: number }) ?? {};
    const products = await syncProducts(agent, { limit: limit ?? 50 });
    return {
      status: 200,
      data: { synced: products.length, products },
    };
  });
}
