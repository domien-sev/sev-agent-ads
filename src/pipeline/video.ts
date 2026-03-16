import type { AdsAgent } from "../agent.js";
import type { AdProductRecord, AdBriefRecord, AdCreativeRecord } from "@domien-sev/shared-types";
import { R2Storage } from "@domien-sev/creative-sdk";
import { createItem, readItems } from "@directus/sdk";
import { randomUUID } from "node:crypto";

/**
 * Video generation pipeline — 3 tiers.
 */

/** Tier 1: Template video via Creatomate (~50% of video volume) */
export async function generateTemplateVideos(
  agent: AdsAgent,
  product: AdProductRecord,
  brief: AdBriefRecord,
): Promise<AdCreativeRecord[]> {
  agent.log.info(`Generating template videos for: ${product.title}`);

  const client = agent.directus.getClient("sev-ai");

  const templates = await client.request(
    readItems("ad_templates", { filter: { active: { _eq: true }, type: { _eq: "video" } }, limit: 5 }),
  ) as AdCreativeRecord[];

  const creatives: AdCreativeRecord[] = [];

  for (const template of templates) {
    const creativeId = randomUUID();

    try {
      const result = await agent.creatomate.renderVideo({
        templateId: (template as unknown as { provider_template_id: string }).provider_template_id,
        modifications: {
          "product-image-1": product.images[0] ?? "",
          "product-image-2": product.images[1] ?? product.images[0] ?? "",
          "product-image-3": product.images[2] ?? product.images[0] ?? "",
          headline: brief.headlines[0] ?? product.title,
          description: brief.descriptions[0] ?? "",
          cta: brief.ctas[0] ?? "Shop Now",
          price: `€${product.price}`,
          ...(product.discount_percent && { discount: `-${product.discount_percent}%` }),
        },
      });

      const r2Key = R2Storage.creativeKey(product.id!, creativeId, "mp4");
      const uploaded = await agent.r2.uploadFromUrl(result.url, r2Key, "video/mp4");

      const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
        brief_id: brief.id!,
        product_id: product.id!,
        campaign_id: brief.campaign_id,
        type: "video",
        tier: "template",
        provider: "creatomate",
        r2_url: uploaded.url,
        r2_key: uploaded.key,
        thumbnail_url: null,
        width: result.width,
        height: result.height,
        duration_seconds: result.duration,
        format: "mp4",
        aspect_ratio: "9:16",
        headline: brief.headlines[0] ?? null,
        description: brief.descriptions[0] ?? null,
        cta: brief.ctas[0] ?? null,
        platform_target: ["meta", "tiktok"],
        status: "approved", // Tier 1 auto-approved
        quality_score: null,
        review_notes: null,
        ab_variant: "VT1-0",
        generation_cost: result.cost,
      };

      const created = await client.request(createItem("ad_creatives", creative));
      creatives.push({ ...creative, id: (created as { id: string }).id } as AdCreativeRecord);
    } catch (err) {
      agent.log.error(`Template video failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  agent.log.info(`Generated ${creatives.length} template videos`);
  return creatives;
}

/** Tier 2: Product video via Creatify URL-to-Video (~30% of video volume) */
export async function generateProductVideos(
  agent: AdsAgent,
  product: AdProductRecord,
  brief: AdBriefRecord,
): Promise<AdCreativeRecord[]> {
  if (!agent.videoGenerator.availableProviders.includes("creatify")) {
    agent.log.warn("Creatify not configured, skipping product videos");
    return [];
  }

  agent.log.info(`Generating product video for: ${product.title}`);
  const client = agent.directus.getClient("sev-ai");
  const creatives: AdCreativeRecord[] = [];
  const creativeId = randomUUID();

  try {
    const productUrl = `https://${process.env.SHOPIFY_SHOP}/products/${product.handle}`;

    const result = await agent.videoGenerator.generate("creatify", {
      productUrl,
      duration: 15,
      aspectRatio: "9:16",
    });

    const r2Key = R2Storage.creativeKey(product.id!, creativeId, "mp4");
    const uploaded = await agent.r2.uploadFromUrl(result.url, r2Key, "video/mp4");

    const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
      brief_id: brief.id!,
      product_id: product.id!,
      campaign_id: brief.campaign_id,
      type: "video",
      tier: "ai-enhanced",
      provider: "creatify",
      r2_url: uploaded.url,
      r2_key: uploaded.key,
      thumbnail_url: null,
      width: result.width,
      height: result.height,
      duration_seconds: result.duration,
      format: "mp4",
      aspect_ratio: "9:16",
      headline: brief.headlines[0] ?? null,
      description: brief.descriptions[0] ?? null,
      cta: brief.ctas[0] ?? null,
      platform_target: ["meta", "tiktok", "pinterest"],
      status: "review",
      quality_score: null,
      review_notes: null,
      ab_variant: "VT2-0",
      generation_cost: result.cost,
    };

    const created = await client.request(createItem("ad_creatives", creative));
    creatives.push({ ...creative, id: (created as { id: string }).id } as AdCreativeRecord);
  } catch (err) {
    agent.log.error(`Product video failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  agent.log.info(`Generated ${creatives.length} product videos`);
  return creatives;
}

/** Tier 3: AI-generated video via Runway (~20% of video volume) */
export async function generateAIVideos(
  agent: AdsAgent,
  product: AdProductRecord,
  brief: AdBriefRecord,
  sourceImageUrl?: string,
): Promise<AdCreativeRecord[]> {
  if (!agent.videoGenerator.availableProviders.includes("runway")) {
    agent.log.warn("Runway not configured, skipping AI videos");
    return [];
  }

  agent.log.info(`Generating AI video for: ${product.title}`);
  const client = agent.directus.getClient("sev-ai");
  const creatives: AdCreativeRecord[] = [];
  const creativeId = randomUUID();

  const imageUrl = sourceImageUrl ?? product.images[0];
  if (!imageUrl) {
    agent.log.warn("No source image for AI video generation");
    return [];
  }

  try {
    const result = await agent.videoGenerator.generate("runway", {
      imageUrl,
      prompt: `Cinematic product reveal of ${product.title}, smooth camera motion, professional lighting`,
      duration: 5,
    });

    const r2Key = R2Storage.creativeKey(product.id!, creativeId, "mp4");
    const uploaded = await agent.r2.uploadFromUrl(result.url, r2Key, "video/mp4");

    const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
      brief_id: brief.id!,
      product_id: product.id!,
      campaign_id: brief.campaign_id,
      type: "video",
      tier: "premium",
      provider: "runway",
      r2_url: uploaded.url,
      r2_key: uploaded.key,
      thumbnail_url: null,
      width: result.width,
      height: result.height,
      duration_seconds: result.duration,
      format: "mp4",
      aspect_ratio: "16:9",
      headline: brief.headlines[0] ?? null,
      description: brief.descriptions[0] ?? null,
      cta: brief.ctas[0] ?? null,
      platform_target: ["meta", "google", "pinterest"],
      status: "review",
      quality_score: null,
      review_notes: null,
      ab_variant: "VT3-0",
      generation_cost: result.cost,
    };

    const created = await client.request(createItem("ad_creatives", creative));
    creatives.push({ ...creative, id: (created as { id: string }).id } as AdCreativeRecord);
  } catch (err) {
    agent.log.error(`AI video failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  agent.log.info(`Generated ${creatives.length} AI videos`);
  return creatives;
}
