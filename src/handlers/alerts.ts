import type { AdsAgent } from "../agent.js";
import type { AdCampaignRecord } from "@domien-sev/shared-types";
import { PerformanceCollector } from "@domien-sev/ads-sdk";
import { getClient, readItems } from "../lib/directus.js";

/**
 * Scheduled alert handler — daily summaries, budget depletion, ROAS drops.
 * Designed to be called on a schedule (cron) rather than via Slack command.
 */

export interface AlertResult {
  alerts: string[];
  summary: string;
}

/** Run daily performance check and generate alerts */
export async function runDailyAlerts(agent: AdsAgent): Promise<AlertResult> {
  const client = getClient(agent);
  const alerts: string[] = [];

  const campaigns = await client.request(
    readItems("ad_campaigns", {
      filter: { status: { _in: ["active"] }, platform_campaign_id: { _nnull: true } },
    }),
  ) as AdCampaignRecord[];

  if (campaigns.length === 0) {
    return { alerts: [], summary: "No active campaigns." };
  }

  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];

  const allPerf = await agent.performanceCollector.getAllPerformance(
    campaigns.filter((c) => c.platform_campaign_id).map((c) => ({
      platform: c.platform,
      campaignId: c.platform_campaign_id!,
    })),
    startDate,
    endDate,
  );

  const enriched = PerformanceCollector.enrichMetrics(allPerf);
  const totalSummary = PerformanceCollector.aggregate(enriched);

  // Alert: low ROAS
  for (const campaign of campaigns) {
    const campaignPerf = enriched.filter((p) => p.campaignId === campaign.platform_campaign_id);
    if (campaignPerf.length === 0) continue;

    const summary = PerformanceCollector.aggregate(campaignPerf);

    if (summary.roas < 1.0 && summary.spend > 10) {
      alerts.push(`ROAS below 1.0 for "${campaign.name}" (${campaign.platform}): ${summary.roas.toFixed(2)}x on €${summary.spend.toFixed(2)} spend`);
    }

    // Budget depletion warning
    if (campaign.total_budget) {
      const remaining = campaign.total_budget - summary.spend;
      const daysLeft = summary.spend > 0 ? remaining / (summary.spend / 1) : Infinity;
      if (daysLeft < 3) {
        alerts.push(`Budget depleting for "${campaign.name}": €${remaining.toFixed(2)} remaining (~${Math.ceil(daysLeft)} days)`);
      }
    }
  }

  const summaryText = [
    `*Daily Summary (${endDate}):*`,
    `Active campaigns: ${campaigns.length}`,
    `Total spend: €${totalSummary.spend.toFixed(2)}`,
    `Total revenue: €${totalSummary.revenue.toFixed(2)}`,
    `Overall ROAS: ${totalSummary.roas.toFixed(2)}x`,
    `Conversions: ${totalSummary.conversions}`,
    alerts.length > 0 ? `\n*Alerts (${alerts.length}):*\n${alerts.map((a) => `- ${a}`).join("\n")}` : "",
  ].join("\n");

  return { alerts, summary: summaryText };
}
