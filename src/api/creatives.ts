import type { AdCreativeRecord, AdProductRecord, CreativeStatus } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import type { ApiRouter } from "./router.js";
import { getClient, readItems, updateItem } from "../lib/directus.js";
import { generateBrief } from "../pipeline/brief.js";
import { generateTemplateImages, generateAIImages, generatePremiumImages } from "../pipeline/image.js";
import { generateTemplateVideos, generateProductVideos, generateAIVideos } from "../pipeline/video.js";
import { processReviewQueue } from "../pipeline/review.js";

export function registerCreativeRoutes(router: ApiRouter, agent: AdsAgent) {
  /**
   * GET /api/creatives?status=X&tier=X&type=X&platform=X&campaign_id=X&product_id=X&limit=50&offset=0
   * List creatives with filters.
   */
  router.get("/api/creatives", async (req) => {
    const { status, tier, type, platform, campaign_id, product_id, limit: limitStr, offset: offsetStr } = req.query;
    const limit = Math.min(parseInt(limitStr || "50", 10), 100);
    const offset = parseInt(offsetStr || "0", 10);

    const filter: Record<string, unknown> = {};
    if (status) filter.status = { _eq: status };
    if (tier) filter.tier = { _eq: tier };
    if (type) filter.type = { _eq: type };
    if (platform) filter.platform_target = { _contains: platform };
    if (campaign_id) filter.campaign_id = { _eq: campaign_id };
    if (product_id) filter.product_id = { _eq: product_id };

    const client = getClient(agent);
    const queryOpts: Record<string, unknown> = { limit, offset, sort: ["-date_created"] };
    if (Object.keys(filter).length > 0) queryOpts.filter = filter;

    const creatives = await client.request(
      readItems("ad_creatives", queryOpts),
    ) as AdCreativeRecord[];

    return { status: 200, data: { items: creatives, limit, offset } };
  });

  /**
   * POST /api/creatives/generate
   * Body: { product_id?: string, query?: string, tiers?: string[] }
   * Generate creatives for a specific product or search query.
   * tiers: ["template", "ai", "premium"] — defaults to all applicable.
   */
  router.post("/api/creatives/generate", async (req) => {
    const { product_id, query, tiers } = (req.body as {
      product_id?: string;
      query?: string;
      tiers?: string[];
    }) ?? {};

    if (!product_id && !query) {
      return { status: 400, data: { error: "Provide product_id or query" } };
    }

    const client = getClient(agent);
    let products: AdProductRecord[];

    if (product_id) {
      products = await client.request(
        readItems("ad_products", { filter: { id: { _eq: product_id } }, limit: 1 }),
      ) as AdProductRecord[];
    } else {
      products = await client.request(
        readItems("ad_products", {
          filter: {
            _or: [
              { title: { _icontains: query } },
              { handle: { _icontains: query } },
              { brand: { _icontains: query } },
              { vendor: { _icontains: query } },
            ],
          },
          limit: 10,
        }),
      ) as AdProductRecord[];
    }

    if (products.length === 0) {
      return { status: 404, data: { error: "No matching products found" } };
    }

    const enabledTiers = new Set(tiers ?? ["template", "ai", "premium"]);
    const results: GenerateResult[] = [];

    for (const product of products) {
      const brief = await generateBrief(agent, product);
      const counts: Record<string, number> = {};

      if (enabledTiers.has("template")) {
        const imgs = await generateTemplateImages(agent, product, brief);
        const vids = await generateTemplateVideos(agent, product, brief);
        counts.template_images = imgs.length;
        counts.template_videos = vids.length;
      }

      if (enabledTiers.has("ai")) {
        const imgs = await generateAIImages(agent, product, brief);
        const vids = await generateProductVideos(agent, product, brief);
        const aiVids = await generateAIVideos(agent, product, brief);
        counts.ai_images = imgs.length;
        counts.product_videos = vids.length;
        counts.ai_videos = aiVids.length;
      }

      if (enabledTiers.has("premium") && product.priority === "hero") {
        const imgs = await generatePremiumImages(agent, product, brief);
        counts.premium_images = imgs.length;
      }

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      results.push({
        product_id: product.id!,
        product_title: product.title,
        brief_id: brief.id!,
        creatives_generated: total,
        breakdown: counts,
      });
    }

    // Run review queue for newly created creatives
    const review = await processReviewQueue(agent);

    return {
      status: 200,
      data: {
        products_processed: results.length,
        results,
        review: {
          auto_approved: review.approved,
          needs_review: review.flagged,
        },
      },
    };
  });

  /**
   * PATCH /api/creatives/:id
   * Body: { status: "approved" | "rejected", review_notes?: string }
   * Approve or reject a creative.
   */
  router.patch("/api/creatives/:id", async (req) => {
    const { id } = req.params;
    const { status, review_notes } = (req.body as {
      status?: CreativeStatus;
      review_notes?: string;
    }) ?? {};

    if (!status || !["approved", "rejected"].includes(status)) {
      return { status: 400, data: { error: "status must be 'approved' or 'rejected'" } };
    }

    const client = getClient(agent);
    const update: Record<string, unknown> = { status };
    if (review_notes) update.review_notes = review_notes;

    await client.request(updateItem("ad_creatives", id, update));

    return { status: 200, data: { id, status, updated: true } };
  });
}

interface GenerateResult {
  product_id: string;
  product_title: string;
  brief_id: string;
  creatives_generated: number;
  breakdown: Record<string, number>;
}
