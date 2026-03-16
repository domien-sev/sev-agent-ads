import Anthropic from "@anthropic-ai/sdk";
import type { AdsAgent } from "../agent.js";
import type { AdProductRecord, AdBriefRecord } from "@domien-sev/shared-types";
import { createItem } from "@directus/sdk";

const anthropic = new Anthropic();

/**
 * Generate creative briefs for products using Claude Sonnet.
 * Produces ad copy variants, creative direction, and platform adaptations.
 */
export async function generateBrief(
  agent: AdsAgent,
  product: AdProductRecord,
  campaignId?: string,
): Promise<AdBriefRecord> {
  agent.log.info(`Generating brief for product: ${product.title}`);

  const prompt = buildBriefPrompt(product);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const parsed = parseBriefResponse(text);

  const brief: Omit<AdBriefRecord, "id" | "date_created" | "date_updated"> = {
    product_id: product.id!,
    campaign_id: campaignId ?? null,
    headlines: parsed.headlines,
    descriptions: parsed.descriptions,
    ctas: parsed.ctas,
    creative_direction: parsed.creativeDirection,
    platform_adaptations: parsed.platformAdaptations,
    targeting_suggestions: parsed.targetingSuggestions,
    status: "draft",
  };

  const client = agent.directus.getClient("sev-ai");
  const created = await client.request(createItem("ad_briefs", brief));
  const result = { ...brief, id: (created as { id: string }).id } as AdBriefRecord;

  agent.log.info(`Brief created: ${result.id} with ${parsed.headlines.length} headlines`);
  return result;
}

/** Generate briefs for multiple products in batch */
export async function generateBriefs(
  agent: AdsAgent,
  products: AdProductRecord[],
  campaignId?: string,
): Promise<AdBriefRecord[]> {
  const briefs: AdBriefRecord[] = [];
  for (const product of products) {
    const brief = await generateBrief(agent, product, campaignId);
    briefs.push(brief);
  }
  return briefs;
}

function buildBriefPrompt(product: AdProductRecord): string {
  const discount = product.discount_percent
    ? `${product.discount_percent}% OFF (was €${product.compare_at_price}, now €${product.price})`
    : `€${product.price}`;

  return `You are an expert fashion ad copywriter for a discount fashion outlet.

Generate ad creative assets for this product:

**Product:** ${product.title}
**Brand:** ${product.brand ?? product.vendor ?? "Unknown"}
**Price:** ${discount}
**Category:** ${product.category ?? product.product_type ?? "Fashion"}
**Color:** ${product.color ?? "N/A"}
**Material:** ${product.material ?? "N/A"}
**Gender:** ${product.gender ?? "unisex"}
**Tags:** ${product.tags.join(", ")}

Respond in this exact JSON format:
{
  "headlines": ["5 short punchy headlines, max 40 chars each"],
  "descriptions": ["3 descriptions, max 125 chars each, highlight the deal"],
  "ctas": ["3 call-to-action options"],
  "creative_direction": {
    "mood": "the overall feeling",
    "style": "visual style direction",
    "color_palette": ["3-4 hex colors that match the product"],
    "layout": "suggested layout approach",
    "notes": "any additional creative notes"
  },
  "platform_adaptations": {
    "meta": { "format": "carousel/single/story", "notes": "meta-specific tips" },
    "google": { "format": "responsive/shopping", "notes": "google-specific tips" },
    "tiktok": { "format": "vertical video/spark", "notes": "tiktok-specific tips" },
    "pinterest": { "format": "standard pin/idea pin", "notes": "pinterest-specific tips" }
  },
  "targeting_suggestions": ["5 audience targeting ideas based on this product"]
}`;
}

function parseBriefResponse(text: string): {
  headlines: string[];
  descriptions: string[];
  ctas: string[];
  creativeDirection: AdBriefRecord["creative_direction"];
  platformAdaptations: AdBriefRecord["platform_adaptations"];
  targetingSuggestions: string[];
} {
  try {
    // Extract JSON from response (may have markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const data = JSON.parse(jsonMatch[0]);

    return {
      headlines: data.headlines ?? [],
      descriptions: data.descriptions ?? [],
      ctas: data.ctas ?? ["Shop Now", "Get the Deal", "Buy Now"],
      creativeDirection: data.creative_direction ?? { mood: "", style: "", color_palette: [], layout: "", notes: null },
      platformAdaptations: data.platform_adaptations ?? {},
      targetingSuggestions: data.targeting_suggestions ?? [],
    };
  } catch {
    // Fallback if parsing fails
    return {
      headlines: ["Shop the Deal", "Limited Time Offer", "Fashion for Less"],
      descriptions: ["Get amazing deals on fashion outlet items.", "Shop now and save big."],
      ctas: ["Shop Now", "Get the Deal", "Buy Now"],
      creativeDirection: { mood: "energetic", style: "minimal", color_palette: ["#000000", "#FFFFFF", "#FF4444"], layout: "centered product", notes: null },
      platformAdaptations: {},
      targetingSuggestions: ["Fashion enthusiasts", "Deal seekers", "Online shoppers"],
    };
  }
}
