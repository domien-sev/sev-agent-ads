import type { AdsAgent } from "../agent.js";
import type { AdPerformanceRecord, AdCampaignRecord } from "@domien-sev/shared-types";
import { PerformanceCollector } from "@domien-sev/ads-sdk";
import { createItem, readItems } from "@directus/sdk";

/**
 * Performance metrics collection + feedback loop utilities.
 */

/** Collect performance data from all platforms and store in Directus */
export async function collectAndStorePerformance(
  agent: AdsAgent,
  daysBack = 1,
): Promise<AdPerformanceRecord[]> {
  const client = agent.directus.getClient("sev-ai") as any;

  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - daysBack * 86_400_000).toISOString().split("T")[0];

  // Get active campaigns with platform IDs
  const campaigns = await client.request(
    readItems("ad_campaigns", {
      filter: { platform_campaign_id: { _nnull: true }, status: { _in: ["active", "paused"] } },
    }),
  ) as AdCampaignRecord[];

  if (campaigns.length === 0) return [];

  const allPerf = await agent.performanceCollector.getAllPerformance(
    campaigns.map((c) => ({ platform: c.platform, campaignId: c.platform_campaign_id! })),
    startDate,
    endDate,
  );

  const enriched = PerformanceCollector.enrichMetrics(allPerf);
  const stored: AdPerformanceRecord[] = [];

  for (const perf of enriched) {
    // Find the Directus campaign ID
    const campaign = campaigns.find((c) => c.platform_campaign_id === perf.campaignId);
    if (!campaign) continue;

    const record: Omit<AdPerformanceRecord, "id" | "date_created"> = {
      creative_id: perf.campaignId, // TODO: map to creative-level when available
      campaign_id: campaign.id!,
      platform: perf.platform,
      date: perf.date,
      impressions: perf.impressions,
      clicks: perf.clicks,
      ctr: perf.ctr,
      spend: perf.spend,
      conversions: perf.conversions,
      revenue: perf.revenue,
      roas: perf.roas,
      cpa: perf.cpa,
      video_views: perf.videoViews ?? null,
      video_completions: perf.videoCompletions ?? null,
    };

    try {
      const created = await client.request(createItem("ad_performance", record));
      stored.push({ ...record, id: (created as { id: string }).id } as AdPerformanceRecord);
    } catch {
      // Unique constraint may prevent duplicate entries — that's fine
    }
  }

  agent.log.info(`Stored ${stored.length} performance records`);
  return stored;
}

/** Get top performing creative styles (for feedback into brief generation) */
export async function getTopPerformingStyles(
  agent: AdsAgent,
  daysBack = 30,
  limit = 10,
): Promise<PerformanceInsight[]> {
  const client = agent.directus.getClient("sev-ai") as any;

  const startDate = new Date(Date.now() - daysBack * 86_400_000).toISOString().split("T")[0];

  const records = await client.request(
    readItems("ad_performance", {
      filter: {
        date: { _gte: startDate },
        spend: { _gt: 5 },
      },
      sort: ["-roas"],
      limit,
    }),
  ) as AdPerformanceRecord[];

  return records.map((r) => ({
    campaignId: r.campaign_id,
    platform: r.platform,
    roas: r.roas,
    ctr: r.ctr,
    spend: r.spend,
    conversions: r.conversions,
  }));
}

interface PerformanceInsight {
  campaignId: string;
  platform: string;
  roas: number;
  ctr: number;
  spend: number;
  conversions: number;
}
