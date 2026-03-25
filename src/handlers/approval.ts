import type { AgentResponse, OptimizationRecommendation, AdCampaignRecord } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import { getClient, updateItem, readItems, createItem } from "../lib/directus.js";

/**
 * Format optimization recommendations as Slack messages for human approval.
 * In full-approval mode, ALL actions require explicit approve/reject.
 */
export function formatRecommendationsForSlack(
  recommendations: OptimizationRecommendation[],
  channelId: string,
  threadTs?: string,
): AgentResponse {
  if (recommendations.length === 0) {
    return {
      channel_id: channelId,
      thread_ts: threadTs,
      text: "Optimization cycle complete. No actions needed — all campaigns performing within thresholds.",
    };
  }

  const lines: string[] = [
    `*Optimization Recommendations — ${recommendations.length} action(s) pending approval:*`,
    "",
  ];

  for (const rec of recommendations) {
    const emoji = getActionEmoji(rec.action.type);
    const actionLabel = getActionLabel(rec);

    lines.push(`${emoji} *${rec.campaign_name}* (${rec.platform})`);
    lines.push(`   Action: ${actionLabel}`);
    lines.push(`   Reason: ${rec.reason}`);
    lines.push(`   Metrics (${rec.metrics.period_days}d): ROAS ${rec.metrics.current_roas.toFixed(2)} | CPA €${rec.metrics.current_cpa.toFixed(2)} | CTR ${rec.metrics.current_ctr.toFixed(2)}% | Spend €${rec.metrics.total_spend.toFixed(2)}`);
    if (rec.rule_name) {
      lines.push(`   Rule: ${rec.rule_name}`);
    }
    lines.push(`   ID: \`${rec.id}\``);
    lines.push("");
  }

  lines.push("─".repeat(40));
  lines.push("*Reply with:*");
  lines.push("`approve all` — Approve and execute all recommendations");
  lines.push("`approve <id>` — Approve a specific recommendation");
  lines.push("`reject all` — Reject all recommendations");
  lines.push("`reject <id>` — Reject a specific recommendation");
  lines.push("`snooze all` — Snooze all for next cycle");

  return {
    channel_id: channelId,
    thread_ts: threadTs,
    text: lines.join("\n"),
  };
}

/**
 * Handle an approval/rejection response from Slack.
 */
export async function handleApprovalResponse(
  agent: AdsAgent,
  text: string,
  pendingRecommendations: OptimizationRecommendation[],
  channelId: string,
  threadTs?: string,
): Promise<AgentResponse> {
  const lower = text.trim().toLowerCase();

  if (lower === "approve all") {
    return executeApprovedRecommendations(agent, pendingRecommendations, channelId, threadTs);
  }

  if (lower === "reject all") {
    for (const rec of pendingRecommendations) rec.status = "rejected";
    await logDecisions(agent, pendingRecommendations, "rejected");
    return {
      channel_id: channelId,
      thread_ts: threadTs,
      text: `Rejected all ${pendingRecommendations.length} recommendation(s). No actions taken.`,
    };
  }

  if (lower === "snooze all") {
    for (const rec of pendingRecommendations) rec.status = "snoozed";
    await logDecisions(agent, pendingRecommendations, "snoozed");
    return {
      channel_id: channelId,
      thread_ts: threadTs,
      text: `Snoozed all ${pendingRecommendations.length} recommendation(s). Will re-evaluate next cycle.`,
    };
  }

  // Handle single approve/reject
  const approveMatch = lower.match(/^approve\s+(.+)$/);
  if (approveMatch) {
    const id = approveMatch[1].trim();
    const rec = pendingRecommendations.find((r) => r.id === id);
    if (!rec) {
      return { channel_id: channelId, thread_ts: threadTs, text: `Recommendation \`${id}\` not found.` };
    }
    return executeApprovedRecommendations(agent, [rec], channelId, threadTs);
  }

  const rejectMatch = lower.match(/^reject\s+(.+)$/);
  if (rejectMatch) {
    const id = rejectMatch[1].trim();
    const rec = pendingRecommendations.find((r) => r.id === id);
    if (!rec) {
      return { channel_id: channelId, thread_ts: threadTs, text: `Recommendation \`${id}\` not found.` };
    }
    rec.status = "rejected";
    await logDecisions(agent, [rec], "rejected");
    return { channel_id: channelId, thread_ts: threadTs, text: `Rejected recommendation for "${rec.campaign_name}".` };
  }

  return {
    channel_id: channelId,
    thread_ts: threadTs,
    text: "Unknown command. Use `approve all`, `approve <id>`, `reject all`, `reject <id>`, or `snooze all`.",
  };
}

/**
 * Execute approved recommendations — the actual platform API calls.
 */
async function executeApprovedRecommendations(
  agent: AdsAgent,
  recommendations: OptimizationRecommendation[],
  channelId: string,
  threadTs?: string,
): Promise<AgentResponse> {
  const client = getClient(agent);
  const results: string[] = [];

  for (const rec of recommendations) {
    try {
      const campaign = (await client.request(
        readItems("ad_campaigns", { filter: { id: { _eq: rec.campaign_id } }, limit: 1 }),
      ) as AdCampaignRecord[])[0];

      if (!campaign) {
        results.push(`Campaign "${rec.campaign_name}" not found — skipped.`);
        rec.status = "failed";
        continue;
      }

      const platformClient = getPlatformClient(agent, campaign.platform);

      switch (rec.action.type) {
        case "pause": {
          if (platformClient && campaign.platform_campaign_id) {
            await platformClient.pauseCampaign(campaign.platform_campaign_id);
          }
          await client.request(updateItem("ad_campaigns", campaign.id!, { status: "paused" }));
          results.push(`Paused "${campaign.name}" on ${campaign.platform}`);
          break;
        }

        case "scale_budget": {
          const newBudget = rec.action.params.proposed_budget as number;
          const oldBudget = campaign.daily_budget;
          await client.request(updateItem("ad_campaigns", campaign.id!, { daily_budget: newBudget }));
          // TODO: Also update budget on the platform via API when platform clients support it
          results.push(`Scaled "${campaign.name}" budget: €${oldBudget.toFixed(2)} → €${newBudget.toFixed(2)}`);
          break;
        }

        case "archive": {
          await client.request(updateItem("ad_campaigns", campaign.id!, { status: "archived" }));
          results.push(`Archived "${campaign.name}"`);
          break;
        }

        case "alert": {
          results.push(`Alert noted for "${campaign.name}": ${rec.reason}`);
          break;
        }
      }

      rec.status = "executed";
      rec.decided_at = new Date().toISOString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`Failed to execute for "${rec.campaign_name}": ${msg}`);
      rec.status = "failed";
    }
  }

  await logDecisions(agent, recommendations, "executed");

  return {
    channel_id: channelId,
    thread_ts: threadTs,
    text: [
      `*Executed ${results.length} optimization action(s):*`,
      "",
      ...results.map((r) => `- ${r}`),
    ].join("\n"),
  };
}

/** Log optimization decisions to Directus agent_events */
async function logDecisions(
  agent: AdsAgent,
  recommendations: OptimizationRecommendation[],
  decision: string,
): Promise<void> {
  const client = getClient(agent);
  try {
    for (const rec of recommendations) {
      await client.request(
        createItem("agent_events", {
          agent: "ads",
          type: `optimization_${decision}`,
          data: {
            recommendation_id: rec.id,
            campaign_id: rec.campaign_id,
            campaign_name: rec.campaign_name,
            platform: rec.platform,
            action: rec.action,
            reason: rec.reason,
            metrics: rec.metrics,
            previous_state: rec.previous_state,
            rule_name: rec.rule_name,
          },
        }),
      );
    }
  } catch (err) {
    agent.log.error(`Failed to log optimization decisions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getPlatformClient(agent: AdsAgent, platform: string) {
  switch (platform) {
    case "meta": return agent.metaAds;
    case "google": return agent.googleAds;
    case "tiktok": return agent.tiktokAds;
    case "pinterest": return agent.pinterestAds;
    default: return undefined;
  }
}

function getActionEmoji(actionType: string): string {
  switch (actionType) {
    case "pause": return ":pause_button:";
    case "scale_budget": return ":chart_with_upwards_trend:";
    case "archive": return ":file_cabinet:";
    case "alert": return ":warning:";
    default: return ":gear:";
  }
}

function getActionLabel(rec: OptimizationRecommendation): string {
  switch (rec.action.type) {
    case "pause":
      return "Pause campaign";
    case "scale_budget": {
      const oldBudget = rec.action.params.original_budget as number;
      const newBudget = rec.action.params.proposed_budget as number;
      const direction = newBudget > oldBudget ? "Increase" : "Decrease";
      const pct = oldBudget > 0 ? Math.abs(((newBudget - oldBudget) / oldBudget) * 100).toFixed(0) : "?";
      return `${direction} budget €${oldBudget?.toFixed(2)} → €${newBudget?.toFixed(2)} (${pct}%)`;
    }
    case "archive":
      return "Archive campaign";
    case "alert": {
      const blockedReason = rec.action.params.blocked_reason as string | undefined;
      return blockedReason ? `Alert (budget change blocked: ${blockedReason})` : "Alert";
    }
    default:
      return rec.action.type;
  }
}
