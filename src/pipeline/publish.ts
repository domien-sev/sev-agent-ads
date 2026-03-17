import type { AdsAgent } from "../agent.js";
import type { AdCampaignRecord, AdCreativeRecord, AdPlatform } from "@domien-sev/shared-types";
import type { AdPlatformClient } from "@domien-sev/ads-sdk";
import { readItems, updateItem } from "@directus/sdk";

/**
 * Campaign publishing pipeline — push approved creatives to ad platforms.
 * Requires campaign approval gate before publishing.
 */

/** Publish approved creatives to the target platform */
export async function publishCampaign(
  agent: AdsAgent,
  campaign: AdCampaignRecord,
): Promise<PublishResult> {
  agent.log.info(`Publishing campaign: ${campaign.name} to ${campaign.platform}`);

  const platformClient = getPlatformClient(agent, campaign.platform);
  if (!platformClient) {
    throw new Error(`Platform client not configured for: ${campaign.platform}`);
  }

  const client = agent.directus.getClient("sev-ai");

  // Get approved creatives for this campaign
  const creatives = await client.request(
    readItems("ad_creatives", {
      filter: {
        campaign_id: { _eq: campaign.id },
        status: { _eq: "approved" },
      },
    }),
  ) as AdCreativeRecord[];

  if (creatives.length === 0) {
    throw new Error("No approved creatives to publish");
  }

  // Create campaign on platform if not already created
  let platformCampaignId = campaign.platform_campaign_id;
  let platformAdsetId = campaign.platform_adset_id;

  if (!platformCampaignId) {
    const result = await platformClient.createCampaign({
      name: campaign.name,
      objective: campaign.objective,
      dailyBudget: campaign.daily_budget,
      totalBudget: campaign.total_budget ?? undefined,
      targeting: campaign.targeting,
      scheduleStart: campaign.schedule_start,
      scheduleEnd: campaign.schedule_end ?? undefined,
    });

    platformCampaignId = result.platformCampaignId;
    platformAdsetId = result.platformAdsetId ?? null;

    await client.request(
      updateItem("ad_campaigns", campaign.id!, {
        platform_campaign_id: platformCampaignId,
        platform_adset_id: platformAdsetId,
      }),
    );
  }

  // Upload each creative as an ad
  const published: string[] = [];
  const failed: string[] = [];

  for (const creative of creatives) {
    try {
      const landingUrl = `https://${process.env.SHOPIFY_SHOP}/products/${creative.product_id}`;

      await platformClient.uploadCreative({
        campaignId: platformCampaignId,
        adsetId: platformAdsetId ?? undefined,
        name: `${campaign.name} - ${creative.ab_variant ?? creative.id}`,
        imageUrl: creative.type === "image" ? creative.asset_url : undefined,
        videoUrl: creative.type === "video" ? creative.asset_url : undefined,
        headline: creative.headline ?? campaign.name,
        description: creative.description ?? "",
        cta: creative.cta ?? "Shop Now",
        landingUrl,
      });

      await client.request(updateItem("ad_creatives", creative.id!, { status: "published" }));
      published.push(creative.id!);
    } catch (err) {
      agent.log.error(`Failed to publish creative ${creative.id}: ${err instanceof Error ? err.message : String(err)}`);
      failed.push(creative.id!);
    }
  }

  // Update campaign status
  await client.request(
    updateItem("ad_campaigns", campaign.id!, { status: "active" }),
  );

  agent.log.info(`Published ${published.length} creatives, ${failed.length} failed`);

  return {
    campaignId: campaign.id!,
    platformCampaignId,
    published: published.length,
    failed: failed.length,
  };
}

/** Build campaign approval message for Slack */
export function buildApprovalMessage(campaign: AdCampaignRecord, creativeCount: number): string {
  return [
    `*Campaign ready for approval:*`,
    "",
    `*Name:* ${campaign.name}`,
    `*Platform:* ${campaign.platform}`,
    `*Objective:* ${campaign.objective}`,
    `*Daily budget:* €${campaign.daily_budget}`,
    `*Creatives:* ${creativeCount}`,
    `*Schedule:* ${campaign.schedule_start}${campaign.schedule_end ? ` → ${campaign.schedule_end}` : " (ongoing)"}`,
    "",
    "Reply `approve campaign` to publish or `reject campaign` to cancel.",
  ].join("\n");
}

function getPlatformClient(agent: AdsAgent, platform: AdPlatform): AdPlatformClient | undefined {
  switch (platform) {
    case "meta":
      return agent.metaAds;
    case "google":
      return agent.googleAds;
    case "tiktok":
      return agent.tiktokAds;
    case "pinterest":
      return agent.pinterestAds;
  }
}

interface PublishResult {
  campaignId: string;
  platformCampaignId: string;
  published: number;
  failed: number;
}
