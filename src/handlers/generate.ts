import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import { syncProducts } from "../pipeline/ingest.js";
import { generateBrief } from "../pipeline/brief.js";
import { generateTemplateImages, generateAIImages, generatePremiumImages } from "../pipeline/image.js";
import { generateTemplateVideos, generateProductVideos, generateAIVideos } from "../pipeline/video.js";
import { processReviewQueue, buildReviewSlackMessage } from "../pipeline/review.js";
import { getClient, readItems } from "../lib/directus.js";

const PAGE_SIZE = 10;

/**
 * Search for products by query (title, handle, brand, vendor, tags).
 * Returns ALL matches (no limit) so we can paginate in-memory.
 */
async function findProducts(agent: AdsAgent, query: string) {
  const client = getClient(agent);
  let products = await client.request(
    readItems("ad_products", {
      filter: {
        _or: [
          { title: { _icontains: query } },
          { handle: { _icontains: query } },
          { brand: { _icontains: query } },
          { vendor: { _icontains: query } },
        ],
      },
      limit: 100,
    }),
  );

  if (products.length === 0) {
    const synced = await syncProducts(agent, { limit: 50 });
    const q = query.toLowerCase();
    products = synced.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.handle.includes(q) ||
        (p.brand ?? "").toLowerCase().includes(q) ||
        (p.vendor ?? "").toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  return products;
}

/**
 * Handler for "generate ads for [product]" and "generate more" commands.
 */
export async function handleGenerate(
  agent: AdsAgent,
  message: RoutedMessage,
  continueFromLast = false,
  groupId?: string,
): Promise<AgentResponse> {
  const text = message.text.trim();
  let productQuery: string;
  let offset: number;

  if (continueFromLast) {
    if (!agent.lastQuery) {
      return {
        channel_id: message.channel_id,
        thread_ts: message.thread_ts ?? message.ts,
        text: "No previous search to continue. Try: `generate ads for [product name or brand]`",
      };
    }
    productQuery = agent.lastQuery;
    offset = agent.lastOffset;
  } else {
    productQuery = text
      .replace(/^(generate|create|make)\s*(ads?|creatives?)?\s*(for)?\s*/i, "")
      .trim();

    if (!productQuery) {
      return {
        channel_id: message.channel_id,
        thread_ts: message.thread_ts ?? message.ts,
        text: "What should I generate ads for? Try: `generate ads for [product name, brand, or Shopify URL]`",
      };
    }

    // Extract handle from Shopify URL if provided
    const urlMatch = productQuery.match(/\/products\/([a-z0-9-]+)/i);
    if (urlMatch) {
      productQuery = urlMatch[1];
    }

    offset = 0;
  }

  // Find all matching products
  const allProducts = await findProducts(agent, productQuery);

  if (allProducts.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: `No products found matching "${productQuery}". Try a different search term.`,
    };
  }

  // Paginate
  const page = allProducts.slice(offset, offset + PAGE_SIZE);

  if (page.length === 0) {
    agent.lastQuery = "";
    agent.lastOffset = 0;
    agent.lastTotalMatches = 0;
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: `No more products to process for "${productQuery}". All ${allProducts.length} have been covered.`,
    };
  }

  // Save pagination state
  agent.lastQuery = productQuery;
  agent.lastOffset = offset + page.length;
  agent.lastTotalMatches = allProducts.length;

  // Generate for this page
  const results: string[] = [];
  let totalCreatives = 0;

  for (const product of page) {
    const brief = await generateBrief(agent, product);

    const templateImages = await generateTemplateImages(agent, product, brief, groupId);
    const aiImages = await generateAIImages(agent, product, brief, groupId);
    const premiumImages = product.priority === "hero"
      ? await generatePremiumImages(agent, product, brief, groupId)
      : [];

    const templateVideos = await generateTemplateVideos(agent, product, brief, groupId);
    const productVideos = await generateProductVideos(agent, product, brief, groupId);
    const aiVideos = await generateAIVideos(agent, product, brief, groupId);

    const count = templateImages.length + aiImages.length + premiumImages.length +
      templateVideos.length + productVideos.length + aiVideos.length;
    totalCreatives += count;

    results.push(`*${product.title}:* ${count} creatives (${templateImages.length} template img, ${aiImages.length} AI img, ${premiumImages.length} premium img, ${templateVideos.length} template vid, ${productVideos.length} product vid, ${aiVideos.length} AI vid)`);
  }

  // Review queue
  const review = await processReviewQueue(agent);
  const reviewMsg = buildReviewSlackMessage(review.creatives.filter((c) => c.status === "review"));

  const remaining = allProducts.length - agent.lastOffset;
  const paginationMsg = remaining > 0
    ? `\n_${remaining} more product(s) matching "${productQuery}" — type \`generate more\` to continue._`
    : "";

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: [
      `Generated ${totalCreatives} creatives for ${page.length} of ${allProducts.length} product(s) (batch ${Math.ceil(offset / PAGE_SIZE) + 1}):`,
      "",
      ...results,
      "",
      `*Review:* ${review.approved} auto-approved, ${review.flagged} need manual review.`,
      "",
      reviewMsg,
      paginationMsg,
    ].join("\n"),
  };
}
