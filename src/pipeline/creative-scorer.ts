import Anthropic from "@anthropic-ai/sdk";
import type { AdsAgent } from "../agent.js";
import type { AdProductRecord, AdCreativeRecord, AdPerformanceRecord } from "@domien-sev/shared-types";
import { getClient, readItems } from "../lib/directus.js";

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScoreBreakdown {
  visual: number;
  attributes: number;
  performance: number;
}

export interface CreativeScore {
  productId: string;
  score: number;
  breakdown: ScoreBreakdown;
  reasoning: string;
  priority: "hero" | "standard" | "low";
}

export interface ScorerOptions {
  enableVision?: boolean;
  visionMaxProducts?: number;
  weights?: { visual: number; attributes: number; performance: number };
}

export type ScoredProduct = AdProductRecord & { _score: CreativeScore };

// ---------------------------------------------------------------------------
// Known brands (European fashion outlet context)
// ---------------------------------------------------------------------------

const KNOWN_BRANDS = new Set([
  "timberland", "tommy hilfiger", "calvin klein", "hugo boss", "ralph lauren",
  "guess", "lacoste", "gant", "napapijri", "superdry", "levi's", "levis",
  "nike", "adidas", "puma", "the north face", "columbia", "jack & jones",
  "scotch & soda", "ted baker", "karl lagerfeld", "emporio armani",
  "michael kors", "coach", "marc o'polo", "marc opolo", "diesel",
  "g-star", "g-star raw", "vans", "converse", "new balance",
]);

// ---------------------------------------------------------------------------
// Category video-friendliness
// ---------------------------------------------------------------------------

const CATEGORY_SCORES: Record<string, number> = {
  // High: strong visual storytelling, movement, lifestyle
  "outerwear": 90, "coats": 90, "jackets": 90, "parka": 90, "puffer": 90,
  "dresses": 85, "dress": 85,
  "shoes": 80, "sneakers": 80, "boots": 80, "footwear": 80,
  // Medium-high: wearable, good on-body appeal
  "tops": 70, "sweaters": 70, "sweater": 70, "hoodie": 70, "hoodies": 70,
  "shirts": 70, "polo": 70, "t-shirts": 65,
  "pants": 65, "jeans": 65, "trousers": 65,
  // Medium: decent but less dynamic
  "bags": 60, "backpacks": 60,
  "suits": 60, "blazers": 60,
  // Lower: smaller items, less visual impact
  "accessories": 45, "hats": 45, "caps": 45, "scarves": 45,
  "socks": 30, "underwear": 30, "belts": 35,
};

// ---------------------------------------------------------------------------
// Season mapping
// ---------------------------------------------------------------------------

const SEASON_MONTHS: Record<string, number[]> = {
  "spring": [3, 4, 5],
  "summer": [6, 7, 8],
  "fall": [9, 10, 11], "autumn": [9, 10, 11],
  "winter": [12, 1, 2],
  // Extended
  "ss": [4, 5, 6, 7, 8], "fw": [9, 10, 11, 12, 1, 2],
  "spring/summer": [4, 5, 6, 7, 8], "fall/winter": [9, 10, 11, 12, 1, 2],
};

// ---------------------------------------------------------------------------
// Bold colors & premium materials
// ---------------------------------------------------------------------------

const BOLD_COLORS = new Set([
  "red", "black", "gold", "orange", "royal blue", "burgundy", "emerald",
  "navy", "cobalt", "crimson", "forest green", "deep blue",
]);

const PREMIUM_MATERIALS = new Set([
  "leather", "cashmere", "silk", "suede", "wool", "merino", "gore-tex",
  "waterproof", "down", "nubuck", "canvas",
]);

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

export async function scoreProducts(
  agent: AdsAgent,
  products: AdProductRecord[],
  options?: ScorerOptions,
): Promise<ScoredProduct[]> {
  const enableVision = options?.enableVision ?? false;
  const visionMax = options?.visionMaxProducts ?? 5;

  // Determine weights
  let weights = options?.weights ?? (enableVision
    ? { visual: 0.30, attributes: 0.40, performance: 0.30 }
    : { visual: 0, attributes: 0.57, performance: 0.43 });

  // Normalize in case custom weights don't sum to 1
  const sum = weights.visual + weights.attributes + weights.performance;
  if (Math.abs(sum - 1) > 0.01) {
    weights = {
      visual: weights.visual / sum,
      attributes: weights.attributes / sum,
      performance: weights.performance / sum,
    };
  }

  // Batch performance lookup (one query, shared across all products)
  const perfMap = await batchPerformanceLookup(agent);

  // Score attributes + performance for all products
  const intermediate: Array<{
    product: AdProductRecord;
    attrResult: { score: number; reasoning: string };
    perfResult: { score: number; reasoning: string };
  }> = [];

  for (const product of products) {
    const attrResult = scoreAttributes(product);
    const perfResult = scorePerformance(product, perfMap);
    intermediate.push({ product, attrResult, perfResult });
  }

  // Vision: if enabled, pick top N by attribute score
  const visionResults = new Map<string, { score: number; reasoning: string }>();

  if (enableVision && weights.visual > 0) {
    const sorted = [...intermediate].sort((a, b) => b.attrResult.score - a.attrResult.score);
    const candidates = sorted.slice(0, visionMax).filter((c) => c.product.images.length > 0);

    const visionPromises = candidates.map(async (c) => {
      const result = await scoreVisual(c.product);
      return { id: c.product.id!, result };
    });

    const settled = await Promise.allSettled(visionPromises);
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        visionResults.set(outcome.value.id, outcome.value.result);
      }
    }
  }

  // Compute final scores
  const scored: ScoredProduct[] = intermediate.map(({ product, attrResult, perfResult }) => {
    const visualResult = visionResults.get(product.id!) ?? { score: 50, reasoning: "Vision not evaluated" };

    // If vision is disabled, redistribute weight
    const effectiveWeights = weights.visual > 0
      ? weights
      : { visual: 0, attributes: weights.attributes, performance: weights.performance };

    const composite = Math.round(
      effectiveWeights.visual * visualResult.score +
      effectiveWeights.attributes * attrResult.score +
      effectiveWeights.performance * perfResult.score,
    );

    const priority: "hero" | "standard" | "low" =
      composite >= 75 ? "hero" :
      composite >= 40 ? "standard" :
      "low";

    const reasoning = [
      `Attributes: ${attrResult.score}/100 (${attrResult.reasoning})`,
      `Performance: ${perfResult.score}/100 (${perfResult.reasoning})`,
      ...(weights.visual > 0 ? [`Visual: ${visualResult.score}/100 (${visualResult.reasoning})`] : []),
      `→ Composite: ${composite}/100 → ${priority}`,
    ].join(". ");

    const _score: CreativeScore = {
      productId: product.id!,
      score: composite,
      breakdown: {
        visual: visualResult.score,
        attributes: attrResult.score,
        performance: perfResult.score,
      },
      reasoning,
      priority,
    };

    return { ...product, priority, _score };
  });

  // Sort by score descending
  scored.sort((a, b) => b._score.score - a._score.score);

  // Log summary
  const heroes = scored.filter((p) => p._score.priority === "hero").length;
  const standards = scored.filter((p) => p._score.priority === "standard").length;
  const lows = scored.filter((p) => p._score.priority === "low").length;
  agent.log.info(`Scored ${scored.length} products: ${heroes} hero, ${standards} standard, ${lows} low`);

  return scored;
}

// ---------------------------------------------------------------------------
// Dimension 1: Product Attributes (heuristic, zero cost)
// ---------------------------------------------------------------------------

function scoreAttributes(product: AdProductRecord): { score: number; reasoning: string } {
  const reasons: string[] = [];

  // 1. Discount strength (weight 0.30)
  let discountScore: number;
  const dp = product.discount_percent ?? 0;
  if (dp >= 70) discountScore = 100;
  else if (dp >= 50) discountScore = 80;
  else if (dp >= 30) discountScore = 60;
  else if (dp >= 10) discountScore = 30;
  else discountScore = 10;
  reasons.push(`discount ${dp}%→${discountScore}`);

  // 2. Category video-friendliness (weight 0.20)
  const cat = (product.category ?? product.product_type ?? "").toLowerCase();
  let categoryScore = 50; // default
  for (const [key, val] of Object.entries(CATEGORY_SCORES)) {
    if (cat.includes(key)) {
      categoryScore = val;
      break;
    }
  }
  // Also check tags for category hints
  if (categoryScore === 50) {
    for (const tag of product.tags) {
      const t = tag.toLowerCase();
      for (const [key, val] of Object.entries(CATEGORY_SCORES)) {
        if (t.includes(key)) {
          categoryScore = Math.max(categoryScore, val);
        }
      }
    }
  }
  reasons.push(`category→${categoryScore}`);

  // 3. Brand recognition (weight 0.15)
  const brandName = (product.brand ?? product.vendor ?? "").toLowerCase();
  const brandScore = KNOWN_BRANDS.has(brandName) ? 80 : 40;
  reasons.push(`brand ${brandScore === 80 ? "known" : "unknown"}→${brandScore}`);

  // 4. Season relevance (weight 0.15)
  const currentMonth = new Date().getMonth() + 1;
  let seasonScore = 50; // null season = neutral
  if (product.season) {
    const seasonKey = product.season.toLowerCase().trim();
    const months = SEASON_MONTHS[seasonKey];
    if (months) {
      if (months.includes(currentMonth)) {
        seasonScore = 100;
      } else {
        // Check adjacent (1 month away from range)
        const adjacent = months.some((m) =>
          Math.abs(m - currentMonth) <= 1 || Math.abs(m - currentMonth) >= 11,
        );
        seasonScore = adjacent ? 60 : 20;
      }
    }
  }
  reasons.push(`season→${seasonScore}`);

  // 5. Color/material appeal (weight 0.10)
  let appealScore = 50;
  const color = (product.color ?? "").toLowerCase();
  const material = (product.material ?? "").toLowerCase();
  if (BOLD_COLORS.has(color)) appealScore += 20;
  if (PREMIUM_MATERIALS.has(material)) appealScore += 20;
  // Check title for material/color hints
  const titleLower = product.title.toLowerCase();
  for (const mat of PREMIUM_MATERIALS) {
    if (titleLower.includes(mat)) { appealScore = Math.min(appealScore + 15, 100); break; }
  }
  appealScore = Math.min(appealScore, 100);
  reasons.push(`appeal→${appealScore}`);

  // 6. Image availability (weight 0.10)
  const imgCount = product.images.length;
  let imageScore: number;
  if (imgCount === 0) imageScore = 0;
  else if (imgCount === 1) imageScore = 30;
  else if (imgCount <= 4) imageScore = 60;
  else imageScore = 90;
  reasons.push(`images(${imgCount})→${imageScore}`);

  // Weighted composite
  const score = Math.round(
    discountScore * 0.30 +
    categoryScore * 0.20 +
    brandScore * 0.15 +
    seasonScore * 0.15 +
    appealScore * 0.10 +
    imageScore * 0.10,
  );

  return { score, reasoning: reasons.join(", ") };
}

// ---------------------------------------------------------------------------
// Dimension 2: Historical Performance (Directus query)
// ---------------------------------------------------------------------------

interface PerfAggregates {
  globalAvgRoas: number;
  byCategoryRoas: Map<string, number>;
  byBrandRoas: Map<string, number>;
}

async function batchPerformanceLookup(agent: AdsAgent): Promise<PerfAggregates> {
  const client = getClient(agent);
  const startDate = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];

  try {
    // Get performance records with spend > 5 in last 30 days
    const perfRecords = await client.request(
      readItems("ad_performance", {
        filter: {
          date: { _gte: startDate },
          spend: { _gt: 5 },
        },
        limit: 500,
      }),
    ) as AdPerformanceRecord[];

    if (perfRecords.length === 0) {
      return { globalAvgRoas: 0, byCategoryRoas: new Map(), byBrandRoas: new Map() };
    }

    // Get creative → product mapping
    const creativeIds = [...new Set(perfRecords.map((r) => r.creative_id))];
    const creatives = await client.request(
      readItems("ad_creatives", {
        filter: { id: { _in: creativeIds } },
        fields: ["id", "product_id"],
        limit: 500,
      }),
    ) as Array<Pick<AdCreativeRecord, "id" | "product_id">>;

    const productIds = [...new Set(creatives.map((c) => c.product_id))];
    const products = await client.request(
      readItems("ad_products", {
        filter: { id: { _in: productIds } },
        fields: ["id", "category", "brand"],
        limit: 500,
      }),
    ) as Array<Pick<AdProductRecord, "id" | "category" | "brand">>;

    // Build lookup maps
    const creativeToProduct = new Map(creatives.map((c) => [c.id!, c.product_id]));
    const productInfo = new Map(products.map((p) => [p.id!, p]));

    // Aggregate ROAS by category and brand
    const categoryRoas = new Map<string, { total: number; count: number }>();
    const brandRoas = new Map<string, { total: number; count: number }>();
    let globalTotal = 0;
    let globalCount = 0;

    for (const perf of perfRecords) {
      const productId = creativeToProduct.get(perf.creative_id);
      const product = productId ? productInfo.get(productId) : undefined;

      globalTotal += perf.roas;
      globalCount++;

      if (product?.category) {
        const cat = product.category.toLowerCase();
        const existing = categoryRoas.get(cat) ?? { total: 0, count: 0 };
        categoryRoas.set(cat, { total: existing.total + perf.roas, count: existing.count + 1 });
      }

      if (product?.brand) {
        const brand = product.brand.toLowerCase();
        const existing = brandRoas.get(brand) ?? { total: 0, count: 0 };
        brandRoas.set(brand, { total: existing.total + perf.roas, count: existing.count + 1 });
      }
    }

    return {
      globalAvgRoas: globalCount > 0 ? globalTotal / globalCount : 0,
      byCategoryRoas: new Map([...categoryRoas].map(([k, v]) => [k, v.total / v.count])),
      byBrandRoas: new Map([...brandRoas].map(([k, v]) => [k, v.total / v.count])),
    };
  } catch {
    return { globalAvgRoas: 0, byCategoryRoas: new Map(), byBrandRoas: new Map() };
  }
}

function scorePerformance(
  product: AdProductRecord,
  perfMap: PerfAggregates,
): { score: number; reasoning: string } {
  if (perfMap.globalAvgRoas === 0) {
    return { score: 50, reasoning: "no historical data" };
  }

  const cat = (product.category ?? product.product_type ?? "").toLowerCase();
  const brand = (product.brand ?? "").toLowerCase();

  const catRoas = perfMap.byCategoryRoas.get(cat);
  const brandRoas = perfMap.byBrandRoas.get(brand);
  const global = perfMap.globalAvgRoas;

  let catScore = 50;
  if (catRoas !== undefined && global > 0) {
    const ratio = catRoas / global;
    catScore = Math.min(100, Math.max(10, Math.round(50 * ratio)));
  }

  let brandScore = 50;
  if (brandRoas !== undefined && global > 0) {
    const ratio = brandRoas / global;
    brandScore = Math.min(100, Math.max(10, Math.round(50 * ratio)));
  }

  const score = Math.round(catScore * 0.5 + brandScore * 0.5);
  const parts: string[] = [];
  if (catRoas !== undefined) parts.push(`cat ROAS ${catRoas.toFixed(1)}x`);
  if (brandRoas !== undefined) parts.push(`brand ROAS ${brandRoas.toFixed(1)}x`);
  if (parts.length === 0) parts.push("no matching category/brand data");

  return { score, reasoning: parts.join(", ") };
}

// ---------------------------------------------------------------------------
// Dimension 3: Visual Analysis (Claude Vision, optional)
// ---------------------------------------------------------------------------

const VISION_PROMPT = `You are evaluating a product image for its creative potential in video advertising.

Score each dimension from 0-100:

1. **composition**: Is the product clearly visible? Clean background? Good framing and lighting?
2. **color_boldness**: Does the product have vibrant, eye-catching colors that would pop in a social media feed? High contrast?
3. **lifestyle_appeal**: Does this product look aspirational or desirable? Would it photograph well in a lifestyle context?

Respond in this exact JSON format only, no other text:
{"composition": <number>, "color_boldness": <number>, "lifestyle_appeal": <number>}`;

async function scoreVisual(
  product: AdProductRecord,
): Promise<{ score: number; reasoning: string }> {
  if (product.images.length === 0) {
    return { score: 0, reasoning: "no images" };
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: product.images[0] } },
          { type: "text", text: VISION_PROMPT },
        ],
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in vision response");

    const data = JSON.parse(jsonMatch[0]) as {
      composition: number;
      color_boldness: number;
      lifestyle_appeal: number;
    };

    // Image count bonus
    const imgCount = product.images.length;
    const imgBonus = imgCount >= 7 ? 100 : imgCount >= 4 ? 75 : imgCount >= 2 ? 50 : 20;

    const score = Math.round(
      data.composition * 0.35 +
      data.color_boldness * 0.30 +
      data.lifestyle_appeal * 0.25 +
      imgBonus * 0.10,
    );

    return {
      score,
      reasoning: `comp=${data.composition} color=${data.color_boldness} lifestyle=${data.lifestyle_appeal} imgs=${imgCount}`,
    };
  } catch {
    return { score: 50, reasoning: "vision analysis failed, using neutral" };
  }
}
