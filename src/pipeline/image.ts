import type { AdsAgent } from "../agent.js";
import type { AdProductRecord, AdBriefRecord, AdCreativeRecord, AdTemplateRecord } from "@domien-sev/shared-types";
import { AssetStorage, SEV_TOKENS, buildTemplateModifications, enrichPromptWithBrand } from "@domien-sev/creative-sdk";
import { getClient, createItem, readItems, importFileFromUrl } from "../lib/directus.js";
import { randomUUID } from "node:crypto";

/**
 * Image generation pipeline — 3 tiers for scale + creativity balance.
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

/** Tier 1: Template-based images via Creatomate (~60% volume) */
export async function generateTemplateImages(
  agent: AdsAgent,
  product: AdProductRecord,
  brief: AdBriefRecord,
): Promise<AdCreativeRecord[]> {
  agent.log.info(`Generating template images for: ${product.title}`);

  const client = getClient(agent);

  // Get active templates from Directus
  const templates = await client.request(
    readItems("ad_templates", { filter: { active: { _eq: true }, type: { _eq: "image" } }, limit: 10 }),
  ) as AdTemplateRecord[];

  const creatives: AdCreativeRecord[] = [];

  for (const template of templates) {
    for (let i = 0; i < Math.min(brief.headlines.length, 3); i++) {
      const headline = brief.headlines[i];
      const cta = brief.ctas[i % brief.ctas.length];
      const creativeId = randomUUID();

      try {
        const brandMods = buildTemplateModifications(SEV_TOKENS);
        const modifications: Record<string, string> = {
          "product-image": product.images[0] ?? "",
          headline,
          cta,
          price: `€${product.price}`,
          ...(product.compare_at_price && { "original-price": `€${product.compare_at_price}` }),
          ...(product.discount_percent && { discount: `-${product.discount_percent}%` }),
          ...Object.fromEntries(Object.entries(brandMods).map(([k, v]) => [k, String(v)])),
        };

        const renderRequest = template.provider_template_id === "source" && template.config
          ? { source: applyModifications(template.config as Record<string, unknown>, modifications) }
          : { templateId: template.provider_template_id, modifications };
        const result = await agent.creatomate.renderImage(renderRequest as any);

        // Upload to asset storage
        const assetKey = AssetStorage.creativeKey(product.id!, creativeId, "jpg");
        const uploaded = await agent.storage.uploadFromUrl(result.url, assetKey, "image/jpeg");

        // Import into Directus Files for preview
        const previewId = await importFileFromUrl(uploaded.url, `${product.title} - ${headline}`);

        const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
          brief_id: brief.id!,
          product_id: product.id!,
          campaign_id: brief.campaign_id,
          type: "image",
          tier: "template",
          provider: "creatomate",
          asset_url: uploaded.url,
          asset_key: uploaded.key,
          thumbnail_url: null,
          preview: previewId,
          width: result.width,
          height: result.height,
          duration_seconds: null,
          format: result.format,
          aspect_ratio: template.aspect_ratio,
          headline,
          description: brief.descriptions[i % brief.descriptions.length] ?? null,
          cta,
          platform_target: template.platforms,
          status: "approved", // Tier 1 auto-approved
          quality_score: null,
          review_notes: null,
          ab_variant: `T1-${i}`,
          generation_cost: result.cost,
        };

        const created = await client.request(createItem("ad_creatives", creative));
        creatives.push({ ...creative, id: (created as { id: string }).id } as AdCreativeRecord);
      } catch (err) {
        agent.log.error(`Template image failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  agent.log.info(`Generated ${creatives.length} template images`);
  return creatives;
}

/** Tier 2: AI-enhanced images via Flux 2 Pro + PhotoRoom (~30% volume) */
export async function generateAIImages(
  agent: AdsAgent,
  product: AdProductRecord,
  brief: AdBriefRecord,
): Promise<AdCreativeRecord[]> {
  agent.log.info(`Generating AI images for: ${product.title}`);

  const client = getClient(agent);
  const creatives: AdCreativeRecord[] = [];
  const cd = brief.creative_direction;

  // Remove background from product image first
  let cleanProductUrl = product.images[0];
  if (cleanProductUrl && agent.bgRemover) {
    try {
      const bgResult = await agent.bgRemover.removeBackground(cleanProductUrl);
      cleanProductUrl = bgResult.url;
    } catch (err) {
      agent.log.warn(`Background removal failed, using original: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Generate lifestyle scenes with product — enriched with brand styling
  const scenes = [
    enrichPromptWithBrand(
      `Fashion product photography: ${product.title} on a ${cd.mood} ${cd.style} background, professional studio lighting, ${product.color ?? "neutral"} tones`,
      SEV_TOKENS,
    ),
    enrichPromptWithBrand(
      `E-commerce lifestyle shot: ${product.title} in an aspirational setting, ${cd.mood} atmosphere, clean composition`,
      SEV_TOKENS,
    ),
  ];

  for (let i = 0; i < scenes.length; i++) {
    const creativeId = randomUUID();

    try {
      const result = await agent.imageGenerator.generate("flux", {
        prompt: scenes[i],
        width: 1080,
        height: 1080,
        referenceImages: cleanProductUrl ? [cleanProductUrl] : undefined,
      });

      const assetKey = AssetStorage.creativeKey(product.id!, creativeId, "png");
      const uploaded = await agent.storage.uploadFromUrl(result.url, assetKey, "image/png");

      const previewId = await importFileFromUrl(uploaded.url, `${product.title} - AI ${i}`);

      const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
        brief_id: brief.id!,
        product_id: product.id!,
        campaign_id: brief.campaign_id,
        type: "image",
        tier: "ai-enhanced",
        provider: "flux",
        asset_url: uploaded.url,
        asset_key: uploaded.key,
        thumbnail_url: null,
        preview: previewId,
        width: result.width,
        height: result.height,
        duration_seconds: null,
        format: result.format,
        aspect_ratio: "1:1",
        headline: brief.headlines[i % brief.headlines.length] ?? null,
        description: brief.descriptions[i % brief.descriptions.length] ?? null,
        cta: brief.ctas[0] ?? null,
        platform_target: ["meta", "google", "pinterest"],
        status: "review", // Tier 2 needs review
        quality_score: null,
        review_notes: null,
        ab_variant: `T2-${i}`,
        generation_cost: result.cost + 0.02, // + bg removal
      };

      const created = await client.request(createItem("ad_creatives", creative));
      creatives.push({ ...creative, id: (created as { id: string }).id } as AdCreativeRecord);
    } catch (err) {
      agent.log.error(`AI image failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  agent.log.info(`Generated ${creatives.length} AI images`);
  return creatives;
}

/** Tier 3: Premium creatives via Recraft v3 or GPT Image (~10% volume) */
export async function generatePremiumImages(
  agent: AdsAgent,
  product: AdProductRecord,
  brief: AdBriefRecord,
): Promise<AdCreativeRecord[]> {
  agent.log.info(`Generating premium images for: ${product.title}`);

  const client = getClient(agent);
  const creatives: AdCreativeRecord[] = [];
  const creativeId = randomUUID();

  // Use Recraft for text-heavy banners (best text rendering)
  const provider = agent.imageGenerator.availableProviders.includes("recraft") ? "recraft" : "openai";
  const discount = product.discount_percent ? `-${product.discount_percent}%` : "";

  try {
    const brandPalette = [SEV_TOKENS.colors.primary, SEV_TOKENS.colors.text, SEV_TOKENS.colors.background, ...brief.creative_direction.color_palette.slice(0, 2)];
    const result = await agent.imageGenerator.generate(provider, {
      prompt: `Fashion sale banner for Shopping Event VIP: "${product.title}" ${discount} — bold ${SEV_TOKENS.fonts.heading} typography, ${brief.creative_direction.style} style, colors: ${brandPalette.join(", ")}. Price €${product.price} prominently displayed. Clean, elegant, warm-toned ad design.`,
      width: 1080,
      height: 1080,
    });

    const assetKey = AssetStorage.creativeKey(product.id!, creativeId, "png");
    const uploaded = await agent.storage.uploadFromUrl(result.url, assetKey, "image/png");

    const previewId = await importFileFromUrl(uploaded.url, `${product.title} - Premium`);

    const creative: Omit<AdCreativeRecord, "id" | "date_created" | "date_updated"> = {
      brief_id: brief.id!,
      product_id: product.id!,
      campaign_id: brief.campaign_id,
      type: "image",
      tier: "premium",
      provider,
      asset_url: uploaded.url,
      asset_key: uploaded.key,
      thumbnail_url: null,
      preview: previewId,
      width: result.width,
      height: result.height,
      duration_seconds: null,
      format: result.format,
      aspect_ratio: "1:1",
      headline: brief.headlines[0] ?? null,
      description: brief.descriptions[0] ?? null,
      cta: brief.ctas[0] ?? null,
      platform_target: ["meta", "google", "tiktok", "pinterest"],
      status: "review", // Tier 3 needs review
      quality_score: null,
      review_notes: null,
      ab_variant: "T3-0",
      generation_cost: result.cost,
    };

    const created = await client.request(createItem("ad_creatives", creative));
    creatives.push({ ...creative, id: (created as { id: string }).id } as AdCreativeRecord);
  } catch (err) {
    agent.log.error(`Premium image failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  agent.log.info(`Generated ${creatives.length} premium images`);
  return creatives;
}
