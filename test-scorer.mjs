/**
 * Standalone test: Creative Potential Scorer against Timberland collection.
 * Runs attribute scoring only (no Directus or Vision needed).
 * Usage: node test-scorer.mjs
 */

// ---------------------------------------------------------------------------
// Scoring logic (mirrors creative-scorer.ts)
// ---------------------------------------------------------------------------

const KNOWN_BRANDS = new Set([
  "timberland", "tommy hilfiger", "calvin klein", "hugo boss", "ralph lauren",
  "guess", "lacoste", "gant", "napapijri", "superdry", "levi's", "levis",
  "nike", "adidas", "puma", "the north face", "columbia", "jack & jones",
  "scotch & soda", "ted baker", "karl lagerfeld", "emporio armani",
  "michael kors", "coach", "marc o'polo", "marc opolo", "diesel",
  "g-star", "g-star raw", "vans", "converse", "new balance",
]);

const CATEGORY_SCORES = {
  "outerwear": 90, "coats": 90, "jackets": 90, "parka": 90, "puffer": 90,
  "dresses": 85, "dress": 85,
  "shoes": 80, "sneakers": 80, "boots": 80, "footwear": 80,
  "tops": 70, "sweaters": 70, "sweater": 70, "hoodie": 70, "hoodies": 70,
  "shirts": 70, "polo": 70, "t-shirts": 65, "tee": 65,
  "pants": 65, "jeans": 65, "trousers": 65,
  "bags": 60, "backpacks": 60,
  "suits": 60, "blazers": 60,
  "accessories": 45, "hats": 45, "caps": 45, "scarves": 45,
  "socks": 30, "underwear": 30, "belts": 35,
};

const SEASON_MONTHS = {
  "spring": [3, 4, 5], "summer": [6, 7, 8],
  "fall": [9, 10, 11], "autumn": [9, 10, 11],
  "winter": [12, 1, 2],
  "ss": [4, 5, 6, 7, 8], "fw": [9, 10, 11, 12, 1, 2],
};

const BOLD_COLORS = new Set([
  "red", "black", "gold", "orange", "royal blue", "burgundy", "emerald",
  "navy", "cobalt", "crimson", "forest green", "deep blue", "chocolate brown",
]);

const PREMIUM_MATERIALS = new Set([
  "leather", "cashmere", "silk", "suede", "wool", "merino", "gore-tex",
  "waterproof", "down", "nubuck", "canvas", "linen", "flannel",
]);

function scoreAttributes(product) {
  const reasons = [];

  // 1. Discount strength (0.30)
  const dp = product.discount_percent ?? 0;
  let discountScore;
  if (dp >= 70) discountScore = 100;
  else if (dp >= 50) discountScore = 80;
  else if (dp >= 30) discountScore = 60;
  else if (dp >= 10) discountScore = 30;
  else discountScore = 10;
  reasons.push(`discount ${dp}%→${discountScore}`);

  // 2. Category video-friendliness (0.20)
  const cat = (product.category ?? "").toLowerCase();
  const titleLower = product.title.toLowerCase();
  let categoryScore = 50;
  for (const [key, val] of Object.entries(CATEGORY_SCORES)) {
    if (cat.includes(key) || titleLower.includes(key)) {
      categoryScore = Math.max(categoryScore, val);
    }
  }
  for (const tag of (product.tags ?? [])) {
    for (const [key, val] of Object.entries(CATEGORY_SCORES)) {
      if (tag.toLowerCase().includes(key)) {
        categoryScore = Math.max(categoryScore, val);
      }
    }
  }
  reasons.push(`category→${categoryScore}`);

  // 3. Brand recognition (0.15)
  const brandName = (product.brand ?? product.vendor ?? "").toLowerCase();
  const brandScore = KNOWN_BRANDS.has(brandName) ? 80 : 40;
  reasons.push(`brand→${brandScore}`);

  // 4. Season relevance (0.15)
  const currentMonth = new Date().getMonth() + 1; // March = 3
  let seasonScore = 50;
  if (product.season) {
    const seasonKey = product.season.toLowerCase().trim();
    const months = SEASON_MONTHS[seasonKey];
    if (months) {
      if (months.includes(currentMonth)) seasonScore = 100;
      else {
        const adjacent = months.some(m => Math.abs(m - currentMonth) <= 1 || Math.abs(m - currentMonth) >= 11);
        seasonScore = adjacent ? 60 : 20;
      }
    }
  }
  reasons.push(`season→${seasonScore}`);

  // 5. Color/material appeal (0.10)
  let appealScore = 50;
  const color = (product.color ?? "").toLowerCase();
  const material = (product.material ?? "").toLowerCase();
  if (BOLD_COLORS.has(color)) appealScore += 20;
  if (PREMIUM_MATERIALS.has(material)) appealScore += 20;
  for (const mat of PREMIUM_MATERIALS) {
    if (titleLower.includes(mat)) { appealScore = Math.min(appealScore + 15, 100); break; }
  }
  appealScore = Math.min(appealScore, 100);
  reasons.push(`appeal→${appealScore}`);

  // 6. Image availability (0.10)
  const imgCount = product.images?.length ?? 3; // assume 3 for test
  let imageScore;
  if (imgCount === 0) imageScore = 0;
  else if (imgCount === 1) imageScore = 30;
  else if (imgCount <= 4) imageScore = 60;
  else imageScore = 90;
  reasons.push(`images(${imgCount})→${imageScore}`);

  const score = Math.round(
    discountScore * 0.30 +
    categoryScore * 0.20 +
    brandScore * 0.15 +
    seasonScore * 0.15 +
    appealScore * 0.10 +
    imageScore * 0.10,
  );

  const priority = score >= 75 ? "hero" : score >= 40 ? "standard" : "low";
  return { score, priority, reasons: reasons.join(", ") };
}

// ---------------------------------------------------------------------------
// Timberland products (from collection page)
// ---------------------------------------------------------------------------

const products = [
  { title: "Scar Ridge Waterproof Parka Black Forest Green", price: 119, compare_at_price: 280, category: "Parka & Jacket", color: "forest green", brand: "timberland", tags: ["parka", "waterproof", "outerwear"] },
  { title: "3D Embroidered Trucker Wheat", price: 18, compare_at_price: 35, category: "Hat", color: "wheat", brand: "timberland", tags: ["hat", "cap", "accessories"] },
  { title: "Williams River Cotton Yd 1/4 Zip Sweater Black Forest Green", price: 40, compare_at_price: 110, category: "Sweater/Vest", color: "forest green", brand: "timberland", tags: ["sweater", "knitwear"] },
  { title: "Williams River Cotton Yd Sweater Black Forest Green", price: 35, compare_at_price: 100, category: "Sweater/Vest", color: "forest green", brand: "timberland", tags: ["sweater", "knitwear"] },
  { title: "Garfield Durable Water Repellent Puffer Jacket Green Gables", price: 70, compare_at_price: 200, category: "Parka & Jacket", color: "green gables", brand: "timberland", tags: ["jacket", "puffer", "outerwear"] },
  { title: "Exeter River Brushed Back Full Zip Hoodie Green Gables", price: 44, compare_at_price: 100, category: "Sweatshirt", color: "green gables", brand: "timberland", tags: ["hoodie", "sweatshirt"] },
  { title: "Maple Grove Low Lace Up Sneaker Deep Lichen Green", price: 45, compare_at_price: 110, category: "Shoes", color: "deep lichen green", brand: "timberland", tags: ["sneaker", "shoes", "footwear"] },
  { title: "Millers River Pique Short Sleeve Polo Green Gables", price: 30, compare_at_price: 65, category: "T-shirt/Polo", color: "green gables", brand: "timberland", tags: ["polo", "t-shirt"] },
  { title: "Hollis Insulated Canvas Jacket Green Gables", price: 85, compare_at_price: 200, category: "Parka & Jacket", color: "green gables", brand: "timberland", tags: ["jacket", "canvas", "outerwear"] },
  { title: "Stretch Poplin Check Shirt Green Gables Yd", price: 35, compare_at_price: 85, category: "Shirt", color: "green gables", brand: "timberland", tags: ["shirt"] },
  { title: "White Ledge Mid Lace Up Waterproof Hiking Boot Chocolate Brown", price: 68, compare_at_price: 150, category: "Boots", color: "chocolate brown", brand: "timberland", tags: ["boots", "hiking", "waterproof", "footwear"] },
  { title: "Hampthon Crew Neck Green Gables", price: 32, compare_at_price: 65, category: "Sweatshirt", color: "green gables", brand: "timberland", tags: ["sweatshirt"] },
  { title: "Midweight Flannel Check Shirt Green Gables Yd", price: 38, compare_at_price: 90, category: "Shirt", color: "green gables", brand: "timberland", tags: ["shirt", "flannel"] },
  { title: "Hampthon Hoodie Pro Green Bay", price: 35, compare_at_price: 70, category: "Sweatshirt", color: "pro green bay", brand: "timberland", tags: ["hoodie", "sweatshirt"] },
  { title: "Hampthon Short Sleeve Tee Green Gables", price: 14, compare_at_price: 35, category: "T-shirt", color: "green gables", brand: "timberland", tags: ["t-shirt", "tee"] },
  { title: "Established 1973 Embroidered Logo Crew Neck Sweatshirt Pro Green Bay", price: 40, compare_at_price: 85, category: "Sweatshirt", color: "pro green bay", brand: "timberland", tags: ["sweatshirt"] },
  { title: "Williams River Cotton Yd Full Zip Sweater Green Gables", price: 33, compare_at_price: 100, category: "Sweater/Vest", color: "green gables", brand: "timberland", tags: ["sweater", "knitwear"] },
  { title: "Mill Brook Linen Shirt Pro Green Bay", price: 39, compare_at_price: 90, category: "Shirt", color: "pro green bay", brand: "timberland", tags: ["shirt", "linen"] },
  { title: "Varsity Graphic Short-Sleeve Tee Green Gables", price: 15, compare_at_price: 35, category: "T-shirt", color: "green gables", brand: "timberland", tags: ["t-shirt", "tee"] },
  { title: "Millers River Pique Short Sleeve Polo Cameo Green", price: 30, compare_at_price: 65, category: "T-shirt/Polo", color: "cameo green", brand: "timberland", tags: ["polo", "t-shirt"] },
];

// Calculate discount percentages
for (const p of products) {
  p.discount_percent = p.compare_at_price > 0
    ? Math.round(((p.compare_at_price - p.price) / p.compare_at_price) * 100)
    : 0;
}

// ---------------------------------------------------------------------------
// Run scoring
// ---------------------------------------------------------------------------

console.log("\n🎯 CREATIVE POTENTIAL SCORER — Timberland Collection\n");
console.log("Weights: discount 30% | category 20% | brand 15% | season 15% | appeal 10% | images 10%");
console.log("Performance dimension: neutral (no historical data)\n");
console.log("─".repeat(110));

const scored = products
  .map(p => ({ ...p, ...scoreAttributes(p) }))
  .sort((a, b) => b.score - a.score);

for (const p of scored) {
  const priorityIcon = p.priority === "hero" ? "⭐" : p.priority === "standard" ? "●" : "○";
  const discount = p.discount_percent ? `-${p.discount_percent}%` : "";
  const title = p.title.length > 55 ? p.title.substring(0, 52) + "..." : p.title;
  console.log(
    `${priorityIcon} ${String(p.score).padStart(3)}/100  ${p.priority.padEnd(8)}  ${title.padEnd(55)}  ${discount.padStart(5)}  │ ${p.reasons}`
  );
}

console.log("─".repeat(110));
const heroes = scored.filter(p => p.priority === "hero").length;
const standards = scored.filter(p => p.priority === "standard").length;
const lows = scored.filter(p => p.priority === "low").length;
console.log(`\nSummary: ${heroes} hero ⭐, ${standards} standard ●, ${lows} low ○`);
console.log(`Top pick for video: ${scored[0].title}`);
console.log(`\nNote: With vision enabled, hero images would also be analyzed for composition, color boldness, and lifestyle appeal.`);
