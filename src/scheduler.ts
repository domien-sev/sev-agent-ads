import cron from "node-cron";
import type { AdsAgent } from "./agent.js";
import type { AdCampaignRecord, AdRuleRecord, CreativeFatigueAlert } from "@domien-sev/shared-types";
import { CampaignOptimizer } from "@domien-sev/ads-sdk";
import { getClient, readItems, createItem } from "./lib/directus.js";
import { formatRecommendationsForSlack } from "./handlers/approval.js";
import { setPendingRecommendations } from "./handlers/optimize.js";
import { runDailyAlerts } from "./handlers/alerts.js";

let optimizeTask: cron.ScheduledTask | null = null;
let alertsTask: cron.ScheduledTask | null = null;

/**
 * Initialize the optimization scheduler.
 *
 * Two cron jobs:
 * 1. Optimization cycle — hourly by default (OPTIMIZE_CRON env var)
 * 2. Daily alerts — once per day at 8 AM (ALERTS_CRON env var)
 *
 * Both post results to the #ads-performance Slack channel via Directus agent_events.
 */
export function initScheduler(agent: AdsAgent): void {
  if (process.env.PAPERCLIP_SCHEDULING_ENABLED === "true") {
    console.log("[scheduler] Paperclip scheduling enabled — skipping node-cron (heartbeats are primary)");
    return;
  }

  initOptimizationCron(agent);
  initAlertsCron(agent);
}

function initOptimizationCron(agent: AdsAgent): void {
  const cronExpr = process.env.OPTIMIZE_CRON ?? "0 * * * *"; // every hour

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid OPTIMIZE_CRON: "${cronExpr}" — falling back to hourly`);
    return initOptimizationWithExpr(agent, "0 * * * *");
  }

  initOptimizationWithExpr(agent, cronExpr);
}

function initOptimizationWithExpr(agent: AdsAgent, cronExpr: string): void {
  optimizeTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running optimization cycle at ${new Date().toISOString()}`);
    try {
      await runOptimizationCycle(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Optimization cycle failed: ${msg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  const nextRun = estimateNextRun(cronExpr);
  console.log(`[scheduler] Optimization scheduled: "${cronExpr}"`);
  console.log(`[scheduler] Next optimization run: ${nextRun}`);
}

function initAlertsCron(agent: AdsAgent): void {
  const cronExpr = process.env.ALERTS_CRON ?? "0 8 * * *"; // 8 AM daily

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid ALERTS_CRON: "${cronExpr}" — falling back to 8 AM daily`);
    return initAlertsWithExpr(agent, "0 8 * * *");
  }

  initAlertsWithExpr(agent, cronExpr);
}

function initAlertsWithExpr(agent: AdsAgent, cronExpr: string): void {
  alertsTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running daily alerts at ${new Date().toISOString()}`);
    try {
      const result = await runDailyAlerts(agent);

      // Post summary to Slack via agent_events
      if (result.summary) {
        await postToSlack(agent, result.summary);
      }

      console.log(`[scheduler] Daily alerts complete. ${result.alerts.length} alert(s).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Daily alerts failed: ${msg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  console.log(`[scheduler] Daily alerts scheduled: "${cronExpr}"`);
}

/**
 * Run the optimization cycle:
 * 1. Collect performance data across all platforms
 * 2. Evaluate rules against campaign metrics
 * 3. Generate recommendations
 * 4. Post to Slack for approval
 */
async function runOptimizationCycle(agent: AdsAgent): Promise<void> {
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

  // Log cycle to agent_events
  try {
    await client.request(
      createItem("agent_events", {
        agent: "ads",
        type: "optimization_cycle",
        data: {
          timestamp: result.timestamp,
          campaigns_analyzed: result.campaigns_analyzed,
          rules_evaluated: result.rules_evaluated,
          recommendations_count: result.recommendations.length,
          errors_count: result.errors.length,
        },
      }),
    );
  } catch {
    console.error("[scheduler] Failed to log optimization cycle to Directus");
  }

  // Log errors
  for (const err of result.errors) {
    console.warn(`[scheduler] Rule error: ${err.campaign} — ${err.error}`);
  }

  const channelId = process.env.ADS_PERFORMANCE_CHANNEL ?? "ads-performance";

  // Post fatigue alerts to Slack
  if (result.fatigue_alerts.length > 0) {
    const fatigueMsg = formatFatigueAlerts(result.fatigue_alerts);
    await postToSlack(agent, fatigueMsg);
    console.log(`[scheduler] Posted ${result.fatigue_alerts.length} fatigue alert(s) to #${channelId}`);
  }

  if (result.recommendations.length === 0 && result.fatigue_alerts.length === 0) {
    console.log(`[scheduler] No recommendations or fatigue alerts — ${result.campaigns_analyzed} campaigns within thresholds.`);
    return;
  }

  if (result.recommendations.length > 0) {
    // Store recommendations for Slack approval flow
    setPendingRecommendations(result.recommendations);

    // Post recommendations to Slack
    const slackMsg = formatRecommendationsForSlack(result.recommendations, channelId);
    await postToSlack(agent, slackMsg.text ?? "Optimization recommendations pending.");
    console.log(`[scheduler] Posted ${result.recommendations.length} recommendation(s) to #${channelId}`);
  }
}

/**
 * Format creative fatigue alerts as a Slack message.
 */
function formatFatigueAlerts(alerts: CreativeFatigueAlert[]): string {
  const actionEmoji: Record<string, string> = {
    refresh_creative: ":art:",
    rotate_creative: ":arrows_counterclockwise:",
    pause_creative: ":no_entry_sign:",
    monitor: ":eyes:",
  };

  const actionLabels: Record<string, string> = {
    refresh_creative: "Generate new creatives",
    rotate_creative: "Rotate to different creative",
    pause_creative: "Pause this creative",
    monitor: "Keep monitoring",
  };

  const lines: string[] = [
    `:warning: *Creative Fatigue Alert — ${alerts.length} creative(s) showing fatigue:*`,
    "",
  ];

  for (const alert of alerts) {
    const emoji = actionEmoji[alert.action] ?? ":gear:";
    lines.push(`${emoji} *${alert.campaign_name}* (${alert.platform}) — Score: ${alert.fatigue_score}/100`);
    lines.push(`   ${alert.reason}`);
    lines.push(`   Recommended: ${actionLabels[alert.action] ?? alert.action}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Post a message to Slack via agent_events.
 * OpenClaw Gateway picks up events and routes to the configured channel.
 */
async function postToSlack(agent: AdsAgent, text: string): Promise<void> {
  const client = getClient(agent);
  const channelId = process.env.ADS_PERFORMANCE_CHANNEL ?? "ads-performance";

  try {
    await client.request(
      createItem("agent_events", {
        agent: "ads",
        type: "slack_message",
        data: {
          channel_id: channelId,
          text,
        },
      }),
    );
  } catch (err) {
    console.error(`[scheduler] Failed to post to Slack: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run optimization cycle on demand (HTTP trigger).
 * Returns the cycle result for the HTTP response.
 */
export async function runOptimizationCycleHttp(agent: AdsAgent) {
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

  if (result.recommendations.length > 0) {
    setPendingRecommendations(result.recommendations);
  }

  return {
    ok: true,
    ...result,
  };
}

/**
 * Stop all cron jobs for graceful shutdown.
 */
export function stopScheduler(): void {
  if (optimizeTask) {
    optimizeTask.stop();
    optimizeTask = null;
    console.log("[scheduler] Optimization cron stopped");
  }
  if (alertsTask) {
    alertsTask.stop();
    alertsTask = null;
    console.log("[scheduler] Alerts cron stopped");
  }
}

/** Simple heuristic to estimate next run time for logging */
function estimateNextRun(expression: string): string {
  const parts = expression.split(" ");
  if (parts.length < 5) return "unknown";

  const minute = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);

  // Hourly pattern: "0 * * * *" — next run is top of next hour
  if (parts[1] === "*") {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(isNaN(minute) ? 0 : minute, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next.toISOString();
  }

  if (isNaN(minute) || isNaN(hour)) return "unknown (complex expression)";

  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
