import type { AdsAgent } from "../agent.js";
import type { AdProductRecord, AdBriefRecord, AdCreativeRecord } from "@domien-sev/shared-types";
import { AssetStorage } from "@domien-sev/creative-sdk";
import { getClient, createItem, readItems, importFileFromUrl } from "../lib/directus.js";
import { randomUUID } from "node:crypto";

/**
 * Video generation pipeline — 3 tiers.
 */

/** Apply modifications to a Creatomate source JSON by matching element names */
function applyModifications(source: Record<string, unknown>, mods: Record<string, string>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  const elements = result.elements as Array<Record<string, unknown>> | undefined;
  if (!elements) return result;
  for (const el of elements) {
    const name = el.name as string | undefined;
    if (name && name in mods) {
      if (el.type === "image") {
        el.source = mods[name];
      } else if (el.type === "text") {
        el.text = mods[name];
      }
    }
  }
  return result;
}

/** Tier 1: Template video via Creatomate (~50% of video volume) */
export async function generateTemplateVideos(
  agent: AdsAgent,
  product: AdProductRecord,
  brief: AdBriefRecord,
): Promise<AdCreativeRecord[]> {
  agent.log.info(`Generating template videos for: ${product.title}`);

  const client = getClient(agent);

  const templates = await client.request(
    readItems("ad_templates", { filter: { active: { _eq: true }, type: { _eq: "video" } }, limit: 5 }),
  ) as AdCreativeRecord[];

  const creatives: AdCreativeRecord[] = [];

  for (const template of templates) {
    const creativeId = randomUUID();

    try {
      const tpl = template as unknown as { provider_template_id: string; config?: Record<string, unknown> };
      const modifications: Record<string, string> = {
        "product-image-1": product.images[0] ?? "",
        "product-image-2": product.images[1] ?? product.images[0] ?? "",
        "product-image-3": product.images[2] ?? product.images[0] ?? "",
        headline: brief.headlines[0] ?? product.title,
        description: brief.descriptions[0] ?? "",
        cta: brief.ctas[0] ?? "Shop Now",
        price: `€${product.price}`,
        ...(product.discount_percent && { discount: `-${product.discount_percent}%` }),
      };

      const renderRequest = tpl.provider_template_id === "source" && tpl.config
        ? { source: applyModifications(tpl.config, modifications) }
        : { templateId: tpl.provider_template_id, modifications };
      const result = await agent.creatomate.renderVideo(renderRequest as any);

      const assetKey = AssetStorage.creativeKey(product.id!, creativeId, "mp4");
      const uploaded = await agent.storage.uploadFromUrl(result.url, assetKey, "video/mp4");

      const previewId = await importFileFromUrl(uploaded.url, `${product.title} - Video`);

      const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
        brief_id: brief.id!,
        product_id: product.id!,
        campaign_id: brief.campaign_id,
        type: "video",
        tier: "template",
        provider: "creatomate",
        asset_url: uploaded.url,
        asset_key: uploaded.key,
        thumbnail_url: null,
        preview: previewId,
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
  const client = getClient(agent);
  const creatives: AdCreativeRecord[] = [];
  const creativeId = randomUUID();

  try {
    const productUrl = `https://${process.env.SHOPIFY_SHOP}/products/${product.handle}`;

    const result = await agent.videoGenerator.generate("creatify", {
      productUrl,
      duration: 15,
      aspectRatio: "9:16",
    });

    const assetKey = AssetStorage.creativeKey(product.id!, creativeId, "mp4");
    const uploaded = await agent.storage.uploadFromUrl(result.url, assetKey, "video/mp4");

    const previewId = await importFileFromUrl(uploaded.url, `${product.title} - Product Video`);

    const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
      brief_id: brief.id!,
      product_id: product.id!,
      campaign_id: brief.campaign_id,
      type: "video",
      tier: "ai-enhanced",
      provider: "creatify",
      asset_url: uploaded.url,
      asset_key: uploaded.key,
      thumbnail_url: null,
      preview: previewId,
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
  const client = getClient(agent);
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

    const assetKey = AssetStorage.creativeKey(product.id!, creativeId, "mp4");
    const uploaded = await agent.storage.uploadFromUrl(result.url, assetKey, "video/mp4");

    const previewId = await importFileFromUrl(uploaded.url, `${product.title} - AI Video`);

    const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
      brief_id: brief.id!,
      product_id: product.id!,
      campaign_id: brief.campaign_id,
      type: "video",
      tier: "premium",
      provider: "runway",
      asset_url: uploaded.url,
      asset_key: uploaded.key,
      thumbnail_url: null,
      preview: previewId,
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
