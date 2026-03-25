import type { RoutedMessage, AgentResponse, AdCampaignRecord, AdRuleRecord, OptimizationRecommendation } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import { CampaignOptimizer } from "@domien-sev/ads-sdk";
import { getClient, readItems, updateItem } from "../lib/directus.js";
import { formatRecommendationsForSlack, handleApprovalResponse } from "./approval.js";

/** Pending recommendations awaiting approval (in-memory, per agent instance) */
let pendingRecommendations: OptimizationRecommendation[] = [];

/**
 * Handler for campaign optimization.
 * "optimize" — run optimization cycle, generate recommendations for approval.
 * "approve ..." / "reject ..." — handle approval responses.
 * "pause [campaign]" — manually pause a campaign.
 */
export async function handleOptimize(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  // Manual pause
  if (text.startsWith("pause")) {
    return pauseCampaign(agent, message);
  }

  // Handle approval/rejection of pending recommendations
  if (text.startsWith("approve") || text.startsWith("reject") || text.startsWith("snooze")) {
    if (pendingRecommendations.length === 0) {
      return {
        channel_id: message.channel_id,
        thread_ts: message.thread_ts ?? message.ts,
        text: "No pending optimization recommendations. Run `optimize` first.",
      };
    }
    return handleApprovalResponse(
      agent,
      text,
      pendingRecommendations,
      message.channel_id,
      message.thread_ts ?? message.ts,
    );
  }

  // Run optimization cycle
  const optimizer = new CampaignOptimizer(agent.performanceCollector);
  const client = getClient(agent);

  const fetchCampaigns = async () =>
    client.request(
      readItems("ad_campaigns", {
        filter: { status: { _eq: "active" }, platform_campaign_id: { _nnull: true } },
      }),
    ) as Promise<AdCampaignRecord[]>;

  const fetchRules = async () =>
    client.request(
      readItems("ad_rules", { filter: { enabled: { _eq: true } } }),
    ) as Promise<AdRuleRecord[]>;

  const result = await optimizer.runCycle(fetchCampaigns, fetchRules);

  // Store pending recommendations for approval flow
  pendingRecommendations = result.recommendations;

  // Build response
  const lines: string[] = [
    `*Optimization Cycle Complete*`,
    `Campaigns analyzed: ${result.campaigns_analyzed} | Rules evaluated: ${result.rules_evaluated}`,
  ];

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`*Errors (${result.errors.length}):*`);
    for (const err of result.errors.slice(0, 5)) {
      lines.push(`- ${err.campaign}: ${err.error}`);
    }
  }

  // Add fatigue alerts to response
  if (result.fatigue_alerts.length > 0) {
    lines.push("");
    lines.push(`:warning: *Creative Fatigue (${result.fatigue_alerts.length}):*`);
    for (const alert of result.fatigue_alerts) {
      const actionLabels: Record<string, string> = {
        refresh_creative: "Generate new creatives",
        rotate_creative: "Rotate creative",
        pause_creative: "Pause creative",
        monitor: "Monitor",
      };
      lines.push(`- *${alert.campaign_name}* (${alert.platform}) — Score: ${alert.fatigue_score}/100`);
      lines.push(`  CTR drop: ${Math.abs(alert.metrics.ctr_drop_pct).toFixed(0)}% | Recommended: ${actionLabels[alert.action] ?? alert.action}`);
    }
  }

  if (result.recommendations.length > 0) {
    // Format recommendations for Slack approval
    const recResponse = formatRecommendationsForSlack(
      result.recommendations,
      message.channel_id,
      message.thread_ts ?? message.ts,
    );
    // Prepend fatigue info if present
    if (result.fatigue_alerts.length > 0) {
      recResponse.text = lines.join("\n") + "\n\n" + recResponse.text;
    }
    return recResponse;
  }

  if (result.fatigue_alerts.length > 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: lines.join("\n"),
    };
  }

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: lines.concat([
      "",
      "No actions needed — all campaigns performing within thresholds.",
    ]).join("\n"),
  };
}

/** Get current pending recommendations (for external access, e.g., cron handler) */
export function getPendingRecommendations(): OptimizationRecommendation[] {
  return pendingRecommendations;
}

/** Set pending recommendations (for cron-triggered optimization) */
export function setPendingRecommendations(recs: OptimizationRecommendation[]): void {
  pendingRecommendations = recs;
}

async function pauseCampaign(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const text = message.text.trim();
  const campaignName = text.replace(/^pause\s*/i, "").trim();

  const client = getClient(agent);
  const campaigns = await client.request(
    readItems("ad_campaigns", {
      filter: { name: { _contains: campaignName }, status: { _eq: "active" } },
      limit: 1,
    }),
  ) as AdCampaignRecord[];

  if (campaigns.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: `No active campaign found matching "${campaignName}".`,
    };
  }

  const campaign = campaigns[0];

  // Pause on platform
  const platformClient = campaign.platform === "meta" ? agent.metaAds
    : campaign.platform === "google" ? agent.googleAds
    : campaign.platform === "tiktok" ? agent.tiktokAds
    : agent.pinterestAds;

  if (platformClient && campaign.platform_campaign_id) {
    await platformClient.pauseCampaign(campaign.platform_campaign_id);
  }

  await client.request(updateItem("ad_campaigns", campaign.id!, { status: "paused" }));

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: `Campaign "${campaign.name}" paused on ${campaign.platform}.`,
  };
}
