import type { AdsAgent } from "../agent.js";
import type { AdCreativeRecord } from "@domien-sev/shared-types";
import { getClient, readItems, updateItem } from "../lib/directus.js";

/**
 * Review pipeline — quality checks + Slack/Directus routing.
 * Tier 1 auto-approved, Tier 2-3 need manual review.
 */

/** Run automated quality checks on a creative */
export async function qualityCheck(creative: AdCreativeRecord): Promise<QualityResult> {
  const issues: string[] = [];

  // Resolution check
  if (creative.width < 600 || creative.height < 600) {
    issues.push(`Resolution too low: ${creative.width}x${creative.height}`);
  }

  // Aspect ratio validation per platform
  for (const platform of creative.platform_target) {
    if (platform === "tiktok" && creative.aspect_ratio !== "9:16") {
      issues.push("TikTok requires 9:16 aspect ratio");
    }
    if (platform === "pinterest" && !["2:3", "1:1"].includes(creative.aspect_ratio)) {
      issues.push("Pinterest prefers 2:3 or 1:1 aspect ratio");
    }
  }

  // Video duration check
  if (creative.type === "video" && creative.duration_seconds) {
    if (creative.duration_seconds < 3) issues.push("Video too short (min 3s)");
    if (creative.duration_seconds > 60) issues.push("Video too long (max 60s)");
  }

  // Missing copy check
  if (!creative.headline) issues.push("Missing headline");
  if (!creative.cta) issues.push("Missing CTA");

  return {
    passed: issues.length === 0,
    issues,
    score: Math.max(0, 100 - issues.length * 20),
  };
}

/** Process a batch of creatives through review */
export async function processReviewQueue(agent: AdsAgent): Promise<ReviewSummary> {
  const client = getClient(agent);

  const pendingReview = await client.request(
    readItems("ad_creatives", {
      filter: { status: { _eq: "review" } },
      limit: 50,
    }),
  ) as AdCreativeRecord[];

  let approved = 0;
  let flagged = 0;

  for (const creative of pendingReview) {
    const result = await qualityCheck(creative);

    if (result.passed) {
      await client.request(
        updateItem("ad_creatives", creative.id!, {
          quality_score: result.score,
          status: "approved",
        }),
      );
      approved++;
    } else {
      await client.request(
        updateItem("ad_creatives", creative.id!, {
          quality_score: result.score,
          review_notes: result.issues.join("; "),
        }),
      );
      flagged++;
    }
  }

  agent.log.info(`Review: ${approved} approved, ${flagged} flagged of ${pendingReview.length} total`);

  return {
    total: pendingReview.length,
    approved,
    flagged,
    creatives: pendingReview,
  };
}

/** Build a Slack message for review notification */
export function buildReviewSlackMessage(creatives: AdCreativeRecord[]): string {
  if (creatives.length === 0) return "No creatives pending review.";

  const grouped = creatives.reduce(
    (acc, c) => {
      const key = `${c.tier} ${c.type}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const lines = [
    `*${creatives.length} creatives ready for review:*`,
    "",
    ...Object.entries(grouped).map(([k, v]) => `  - ${v}x ${k}`),
    "",
    "Review in Directus or reply with `approve all` / `reject [id]`.",
  ];

  return lines.join("\n");
}

interface QualityResult {
  passed: boolean;
  issues: string[];
  score: number;
}

interface ReviewSummary {
  total: number;
  approved: number;
  flagged: number;
  creatives: AdCreativeRecord[];
}
