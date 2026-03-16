import type { RoutedMessage, AgentResponse, AdCampaignRecord } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import { PerformanceCollector } from "@domien-sev/ads-sdk";
import { readItems } from "@directus/sdk";

/**
 * Handler for performance reporting.
 * "report daily" / "report weekly" / "performance [campaign]"
 */
export async function handleReport(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  const isWeekly = text.includes("weekly") || text.includes("week");
  const days = isWeekly ? 7 : 1;

  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

  const client = agent.directus.getClient("sev-ai");

  // Get active campaigns
  const campaigns = await client.request(
    readItems("ad_campaigns", {
      filter: { status: { _in: ["active", "paused"] } },
    }),
  ) as AdCampaignRecord[];

  if (campaigns.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: "No active campaigns to report on.",
    };
  }

  // Collect performance data from all platforms
  const campaignRefs = campaigns
    .filter((c) => c.platform_campaign_id)
    .map((c) => ({
      platform: c.platform,
      campaignId: c.platform_campaign_id!,
    }));

  const perfData = await agent.performanceCollector.getAllPerformance(campaignRefs, startDate, endDate);
  const enriched = PerformanceCollector.enrichMetrics(perfData);
  const summary = PerformanceCollector.aggregate(enriched);

  // Group by platform
  const byPlatform = new Map<string, typeof perfData>();
  for (const d of enriched) {
    const existing = byPlatform.get(d.platform) ?? [];
    existing.push(d);
    byPlatform.set(d.platform, existing);
  }

  const lines: string[] = [
    `*${isWeekly ? "Weekly" : "Daily"} Performance Report (${startDate} → ${endDate})*`,
    "",
    `*Total:* ${summary.impressions.toLocaleString()} impressions | ${summary.clicks.toLocaleString()} clicks | €${summary.spend.toFixed(2)} spend`,
    `*ROAS:* ${summary.roas.toFixed(2)}x | *CPA:* €${summary.cpa.toFixed(2)} | *CTR:* ${summary.ctr.toFixed(2)}%`,
    `*Revenue:* €${summary.revenue.toFixed(2)} | *Conversions:* ${summary.conversions}`,
    "",
  ];

  for (const [platform, data] of byPlatform) {
    const platformSummary = PerformanceCollector.aggregate(data);
    lines.push(
      `*${platform.toUpperCase()}:* €${platformSummary.spend.toFixed(2)} spend | ROAS ${platformSummary.roas.toFixed(2)}x | ${platformSummary.conversions} conv`,
    );
  }

  // Top performers
  if (enriched.length > 0) {
    const { top } = PerformanceCollector.rankCreatives(enriched, "roas", 3);
    if (top.length > 0) {
      lines.push("", "*Top Performers (ROAS):*");
      for (const t of top) {
        lines.push(`  - ${t.platform} campaign: ROAS ${t.roas.toFixed(2)}x, €${t.spend.toFixed(2)} spend`);
      }
    }
  }

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: lines.join("\n"),
  };
}
