import type { RoutedMessage, AgentResponse, AdCampaignRecord, AdRuleRecord } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import { PerformanceCollector } from "@domien-sev/ads-sdk";
import { readItems, updateItem } from "@directus/sdk";

/**
 * Handler for campaign optimization.
 * "optimize" — run automation rules (pause underperformers, scale winners).
 * "pause [campaign]" — manually pause a campaign.
 */
export async function handleOptimize(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  // Manual pause
  if (text.startsWith("pause")) {
    return pauseCampaign(agent, message);
  }

  // Run optimization rules
  const client = agent.directus.getClient("sev-ai");

  const rules = await client.request(
    readItems("ad_rules", { filter: { enabled: { _eq: true } } }),
  ) as AdRuleRecord[];

  const campaigns = await client.request(
    readItems("ad_campaigns", {
      filter: { status: { _eq: "active" }, platform_campaign_id: { _nnull: true } },
    }),
  ) as AdCampaignRecord[];

  if (campaigns.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: "No active campaigns to optimize.",
    };
  }

  const actions: string[] = [];
  const endDate = new Date().toISOString().split("T")[0];

  for (const campaign of campaigns) {
    for (const rule of rules) {
      if (rule.platform !== "all" && rule.platform !== campaign.platform) continue;

      const startDate = new Date(
        Date.now() - rule.trigger.period_days * 86_400_000,
      ).toISOString().split("T")[0];

      try {
        const perfData = await agent.performanceCollector.getPerformance(
          campaign.platform,
          campaign.platform_campaign_id!,
          startDate,
          endDate,
        );

        const summary = PerformanceCollector.aggregate(perfData);
        const metricValue = summary[rule.trigger.metric as keyof typeof summary] as number;

        const triggered = evaluateCondition(metricValue, rule.trigger.operator, rule.trigger.value);

        if (triggered) {
          const actionResult = await executeAction(agent, campaign, rule);
          actions.push(actionResult);

          await client.request(
            updateItem("ad_rules", rule.id!, { last_triggered: new Date().toISOString() }),
          );
        }
      } catch (err) {
        agent.log.error(`Rule ${rule.name} failed for campaign ${campaign.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: actions.length > 0
      ? [`*Optimization run — ${actions.length} action(s):*`, "", ...actions].join("\n")
      : "Optimization run complete. No actions needed — all campaigns performing within thresholds.",
  };
}

async function pauseCampaign(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const text = message.text.trim();
  const campaignName = text.replace(/^pause\s*/i, "").trim();

  const client = agent.directus.getClient("sev-ai");
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

function evaluateCondition(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case "lt": return value < threshold;
    case "gt": return value > threshold;
    case "eq": return value === threshold;
    default: return false;
  }
}

async function executeAction(agent: AdsAgent, campaign: AdCampaignRecord, rule: AdRuleRecord): Promise<string> {
  const client = agent.directus.getClient("sev-ai");

  switch (rule.action.type) {
    case "pause": {
      const platformClient = campaign.platform === "meta" ? agent.metaAds
        : campaign.platform === "google" ? agent.googleAds
        : campaign.platform === "tiktok" ? agent.tiktokAds
        : agent.pinterestAds;

      if (platformClient && campaign.platform_campaign_id) {
        await platformClient.pauseCampaign(campaign.platform_campaign_id);
      }
      await client.request(updateItem("ad_campaigns", campaign.id!, { status: "paused" }));
      return `Paused "${campaign.name}" (${campaign.platform}) — rule: ${rule.name}`;
    }

    case "alert":
      return `Alert: "${campaign.name}" (${campaign.platform}) triggered rule "${rule.name}"`;

    case "archive":
      await client.request(updateItem("ad_campaigns", campaign.id!, { status: "archived" }));
      return `Archived "${campaign.name}" (${campaign.platform}) — rule: ${rule.name}`;

    case "scale_budget": {
      const multiplier = (rule.action.params.multiplier as number) ?? 1.2;
      const newBudget = campaign.daily_budget * multiplier;
      await client.request(updateItem("ad_campaigns", campaign.id!, { daily_budget: newBudget }));
      return `Scaled "${campaign.name}" budget €${campaign.daily_budget} → €${newBudget.toFixed(2)} — rule: ${rule.name}`;
    }

    default:
      return `Unknown action "${rule.action.type}" for rule "${rule.name}"`;
  }
}
