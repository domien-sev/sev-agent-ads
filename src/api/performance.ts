import type { AdCampaignRecord } from "@domien-sev/shared-types";
import { PerformanceCollector } from "@domien-sev/ads-sdk";
import type { AdsAgent } from "../agent.js";
import type { ApiRouter } from "./router.js";
import { getClient, readItems } from "../lib/directus.js";

export function registerPerformanceRoutes(router: ApiRouter, agent: AdsAgent) {
  /**
   * GET /api/performance?campaign_id=X&platform=X&days=7&start=YYYY-MM-DD&end=YYYY-MM-DD
   * Fetch performance data from ad platforms.
   * - campaign_id: filter to a single campaign
   * - platform: filter to a single platform
   * - days: shorthand for last N days (default 7)
   * - start/end: explicit date range (overrides days)
   */
  router.get("/api/performance", async (req) => {
    const { campaign_id, platform, days: daysStr, start, end } = req.query;

    const days = parseInt(daysStr || "7", 10);
    const endDate = end ?? new Date().toISOString().split("T")[0];
    const startDate = start ?? new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

    const client = getClient(agent);

    // Build campaign filter
    const filter: Record<string, unknown> = {
      status: { _in: ["active", "paused"] },
    };
    if (campaign_id) filter.id = { _eq: campaign_id };
    if (platform) filter.platform = { _eq: platform };

    const campaigns = await client.request(
      readItems("ad_campaigns", { filter }),
    ) as AdCampaignRecord[];

    if (campaigns.length === 0) {
      return {
        status: 200,
        data: {
          period: { start: startDate, end: endDate },
          campaigns: [],
          totals: null,
        },
      };
    }

    const campaignRefs = campaigns
      .filter((c) => c.platform_campaign_id)
      .map((c) => ({
        platform: c.platform,
        campaignId: c.platform_campaign_id!,
      }));

    if (campaignRefs.length === 0) {
      return {
        status: 200,
        data: {
          period: { start: startDate, end: endDate },
          campaigns: campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            platform: c.platform,
            status: c.status,
            note: "Not yet published to platform",
          })),
          totals: null,
        },
      };
    }

    const perfData = await agent.performanceCollector.getAllPerformance(campaignRefs, startDate, endDate);
    const enriched = PerformanceCollector.enrichMetrics(perfData);
    const totals = PerformanceCollector.aggregate(enriched);

    // Group by campaign
    const byCampaign = new Map<string, typeof enriched>();
    for (const d of enriched) {
      const key = d.campaignId;
      const existing = byCampaign.get(key) ?? [];
      existing.push(d);
      byCampaign.set(key, existing);
    }

    const campaignResults = campaigns.map((c) => {
      const data = byCampaign.get(c.platform_campaign_id!) ?? [];
      const agg = data.length > 0 ? PerformanceCollector.aggregate(data) : null;
      return {
        id: c.id,
        name: c.name,
        platform: c.platform,
        status: c.status,
        platform_campaign_id: c.platform_campaign_id,
        metrics: agg,
      };
    });

    return {
      status: 200,
      data: {
        period: { start: startDate, end: endDate },
        campaigns: campaignResults,
        totals,
      },
    };
  });
}
