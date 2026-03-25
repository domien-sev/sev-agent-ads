import type { RoutedMessage, AgentResponse, AdCampaignRecord, AdCreativeRecord, AdPlatform } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import { getClient, createItem, readItems, updateItem } from "../lib/directus.js";
import { buildApprovalMessage, publishCampaign } from "../pipeline/publish.js";

/**
 * Handler for campaign management commands.
 * "create campaign [name] on [platform]"
 * "approve campaign"
 * "launch campaign [name]"
 */
export async function handleCampaign(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  // Approve pending campaign
  if (text.includes("approve campaign") || text.includes("approve")) {
    return approveAndPublish(agent, message);
  }

  // Create new campaign
  const match = text.match(/(?:create|launch)\s+campaign\s+["']?(.+?)["']?\s+(?:on|for)\s+(meta|google|tiktok|pinterest)/i);
  if (!match) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: "Usage: `create campaign \"Campaign Name\" on meta|google|tiktok|pinterest`",
    };
  }

  const [, campaignName, platform] = match;

  // Get approved creatives that aren't in a campaign yet
  const client = getClient(agent);
  const availableCreatives = (await client.request(
    readItems("ad_creatives", {
      filter: {
        status: { _eq: "approved" },
        campaign_id: { _null: true },
        platform_target: { _contains: platform },
      },
      limit: 50,
    }),
  )) as AdCreativeRecord[];

  if (availableCreatives.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: `No approved creatives available for ${platform}. Generate some first with \`generate ads for [product]\`.`,
    };
  }

  // Create campaign in Directus
  const campaign: Omit<AdCampaignRecord, "id" | "date_created" | "date_updated"> = {
    name: campaignName,
    group_id: null,
    platform: platform as AdPlatform,
    platform_campaign_id: null,
    platform_adset_id: null,
    objective: "conversions",
    daily_budget: 20,
    total_budget: null,
    targeting: {
      age_min: 18,
      age_max: 65,
      locations: ["BE", "NL"],
    },
    schedule_start: new Date().toISOString(),
    schedule_end: null,
    product_ids: [...new Set(availableCreatives.map((c) => (c as { product_id: string }).product_id))],
    creative_ids: availableCreatives.map((c) => (c as { id: string }).id),
    status: "pending_approval",
    approval_notes: null,
  };

  const created = await client.request(createItem("ad_campaigns", campaign));
  const campaignId = (created as { id: string }).id;

  // Assign creatives to campaign
  for (const creative of availableCreatives) {
    await client.request(updateItem("ad_creatives", (creative as { id: string }).id, { campaign_id: campaignId }));
  }

  // Post approval request
  const approvalMsg = buildApprovalMessage(
    { ...campaign, id: campaignId } as AdCampaignRecord,
    availableCreatives.length,
  );

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: approvalMsg,
  };
}

async function approveAndPublish(agent: AdsAgent, message: RoutedMessage): Promise<AgentResponse> {
  const client = getClient(agent);

  // Find pending campaigns
  const pending = await client.request(
    readItems("ad_campaigns", {
      filter: { status: { _eq: "pending_approval" } },
      limit: 1,
      sort: ["-date_created"],
    }),
  ) as AdCampaignRecord[];

  if (pending.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: "No campaigns pending approval.",
    };
  }

  const campaign = pending[0];

  // Update status
  await client.request(
    updateItem("ad_campaigns", campaign.id!, { status: "approved" }),
  );

  // Publish to platform
  try {
    const result = await publishCampaign(agent, campaign);

    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: [
        `Campaign "${campaign.name}" published to ${campaign.platform}!`,
        `Platform ID: ${result.platformCampaignId}`,
        `Creatives published: ${result.published}`,
        result.failed > 0 ? `Failed: ${result.failed}` : "",
        "",
        "Campaign is live but paused. Reply `resume campaign` to activate.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } catch (err) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: `Failed to publish: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
