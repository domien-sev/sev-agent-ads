import type { AdsAgent } from "../agent.js";
import type { AdProductRecord, AdBriefRecord, AdCreativeRecord, CreativeTier } from "@domien-sev/shared-types";
import { generateBrief } from "../pipeline/brief.js";
import { generateTemplateImages, generateAIImages, generatePremiumImages } from "../pipeline/image.js";
import { generateTemplateVideos, generateProductVideos, generateAIVideos } from "../pipeline/video.js";

/**
 * Creative generation orchestration — coordinates the full creative pipeline
 * for a product across all tiers.
 */

export interface GenerationOptions {
  tiers?: CreativeTier[];
  includeVideo?: boolean;
  campaignId?: string;
}

/** Run the full creative generation pipeline for a product */
export async function generateCreativesForProduct(
  agent: AdsAgent,
  product: AdProductRecord,
  options: GenerationOptions = {},
): Promise<GenerationResult> {
  const tiers = options.tiers ?? ["template", "ai-enhanced", "premium"];
  const includeVideo = options.includeVideo ?? true;

  // Step 1: Generate brief
  const brief = await generateBrief(agent, product, options.campaignId);

  const images: AdCreativeRecord[] = [];
  const videos: AdCreativeRecord[] = [];

  // Step 2: Image generation per tier
  if (tiers.includes("template")) {
    images.push(...await generateTemplateImages(agent, product, brief));
  }

  if (tiers.includes("ai-enhanced")) {
    images.push(...await generateAIImages(agent, product, brief));
  }

  if (tiers.includes("premium") && product.priority === "hero") {
    images.push(...await generatePremiumImages(agent, product, brief));
  }

  // Step 3: Video generation per tier
  if (includeVideo) {
    if (tiers.includes("template")) {
      videos.push(...await generateTemplateVideos(agent, product, brief));
    }

    if (tiers.includes("ai-enhanced")) {
      videos.push(...await generateProductVideos(agent, product, brief));
    }

    if (tiers.includes("premium") && product.priority === "hero") {
      // Use best AI image as source for AI video
      const bestImage = images.find((i) => i.tier === "ai-enhanced" || i.tier === "premium");
      videos.push(...await generateAIVideos(agent, product, brief, bestImage?.asset_url));
    }
  }

  const totalCost = [...images, ...videos].reduce((sum, c) => sum + c.generation_cost, 0);

  return {
    brief,
    images,
    videos,
    totalCreatives: images.length + videos.length,
    totalCost,
  };
}

/** Batch generate creatives for multiple products */
export async function batchGenerate(
  agent: AdsAgent,
  products: AdProductRecord[],
  options: GenerationOptions = {},
): Promise<BatchResult> {
  const results: GenerationResult[] = [];

  for (const product of products) {
    try {
      const result = await generateCreativesForProduct(agent, product, options);
      results.push(result);
    } catch (err) {
      agent.log.error(`Failed to generate for ${product.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    products: results.length,
    totalCreatives: results.reduce((sum, r) => sum + r.totalCreatives, 0),
    totalCost: results.reduce((sum, r) => sum + r.totalCost, 0),
    results,
  };
}

interface GenerationResult {
  brief: AdBriefRecord;
  images: AdCreativeRecord[];
  videos: AdCreativeRecord[];
  totalCreatives: number;
  totalCost: number;
}

interface BatchResult {
  products: number;
  totalCreatives: number;
  totalCost: number;
  results: GenerationResult[];
}
