import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import { syncProducts } from "../pipeline/ingest.js";
import { generateBrief } from "../pipeline/brief.js";
import { generateTemplateImages, generateAIImages, generatePremiumImages } from "../pipeline/image.js";
import { generateTemplateVideos, generateProductVideos } from "../pipeline/video.js";
import { processReviewQueue, buildReviewSlackMessage } from "../pipeline/review.js";
import { readItems } from "@directus/sdk";

/**
 * Handler for "generate ads for [product]" commands.
 * Full pipeline: sync → brief → images (3 tiers) → videos → review.
 */
export async function handleGenerate(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const text = message.text.trim();

  // Parse product reference from message
  const productQuery = text
    .replace(/^(generate|create|make)\s*(ads?|creatives?)?\s*(for)?\s*/i, "")
    .trim();

  if (!productQuery) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: "What should I generate ads for? Try: `generate ads for [product name or handle]`",
    };
  }

  // Step 1: Find or sync product
  const client = agent.directus.getClient("sev-ai");
  let products = await client.request(
    readItems("ad_products", {
      filter: {
        _or: [
          { title: { _contains: productQuery } },
          { handle: { _contains: productQuery } },
          { tags: { _contains: productQuery } },
        ],
      },
      limit: 5,
    }),
  );

  if (products.length === 0) {
    // Try syncing from Shopify first
    const synced = await syncProducts(agent, { limit: 20 });
    products = synced.filter(
      (p) =>
        p.title.toLowerCase().includes(productQuery.toLowerCase()) ||
        p.handle.includes(productQuery.toLowerCase()),
    );
  }

  if (products.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: `No products found matching "${productQuery}". Try syncing first or use a different search term.`,
    };
  }

  // Step 2: Generate for each matched product
  const results: string[] = [];
  let totalCreatives = 0;

  for (const product of products) {
    // Brief generation
    const brief = await generateBrief(agent, product);

    // Image generation (all tiers)
    const templateImages = await generateTemplateImages(agent, product, brief);
    const aiImages = await generateAIImages(agent, product, brief);

    // Only generate premium for hero products
    const premiumImages = product.priority === "hero"
      ? await generatePremiumImages(agent, product, brief)
      : [];

    // Video generation
    const templateVideos = await generateTemplateVideos(agent, product, brief);
    const productVideos = await generateProductVideos(agent, product, brief);

    const count = templateImages.length + aiImages.length + premiumImages.length +
      templateVideos.length + productVideos.length;
    totalCreatives += count;

    results.push(`*${product.title}:* ${count} creatives (${templateImages.length} template img, ${aiImages.length} AI img, ${premiumImages.length} premium img, ${templateVideos.length} template vid, ${productVideos.length} product vid)`);
  }

  // Step 3: Process review queue
  const review = await processReviewQueue(agent);
  const reviewMsg = buildReviewSlackMessage(review.creatives.filter((c) => c.status === "review"));

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: [
      `Generated ${totalCreatives} creatives for ${products.length} product(s):`,
      "",
      ...results,
      "",
      `*Review:* ${review.approved} auto-approved, ${review.flagged} need manual review.`,
      "",
      reviewMsg,
    ].join("\n"),
  };
}
