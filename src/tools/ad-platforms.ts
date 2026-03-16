import type { AdsAgent } from "../agent.js";
import type { AdPlatform, AdCampaignRecord } from "@domien-sev/shared-types";
import type { AdPlatformClient, CreateCampaignRequest, CampaignResult } from "@domien-sev/ads-sdk";

/**
 * Ad platform helper utilities.
 */

/** Get the platform client for a given platform */
export function getPlatformClient(agent: AdsAgent, platform: AdPlatform): AdPlatformClient | undefined {
  switch (platform) {
    case "meta": return agent.metaAds;
    case "google": return agent.googleAds;
    case "tiktok": return agent.tiktokAds;
    case "pinterest": return agent.pinterestAds;
  }
}

/** Get all configured platform clients */
export function getConfiguredPlatforms(agent: AdsAgent): AdPlatform[] {
  const platforms: AdPlatform[] = [];
  if (agent.metaAds) platforms.push("meta");
  if (agent.googleAds) platforms.push("google");
  if (agent.tiktokAds) platforms.push("tiktok");
  if (agent.pinterestAds) platforms.push("pinterest");
  return platforms;
}

/** Create campaigns on multiple platforms from the same spec */
export async function createMultiPlatformCampaign(
  agent: AdsAgent,
  platforms: AdPlatform[],
  request: CreateCampaignRequest,
): Promise<Map<AdPlatform, CampaignResult>> {
  const results = new Map<AdPlatform, CampaignResult>();

  for (const platform of platforms) {
    const client = getPlatformClient(agent, platform);
    if (!client) continue;

    try {
      const result = await client.createCampaign({
        ...request,
        name: `${request.name} — ${platform}`,
      });
      results.set(platform, result);
    } catch (err) {
      agent.log.error(`Campaign creation failed on ${platform}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

/** Pause campaigns across all platforms */
export async function pauseAllCampaigns(
  agent: AdsAgent,
  campaigns: AdCampaignRecord[],
): Promise<{ paused: string[]; failed: string[] }> {
  const paused: string[] = [];
  const failed: string[] = [];

  for (const campaign of campaigns) {
    const client = getPlatformClient(agent, campaign.platform);
    if (!client || !campaign.platform_campaign_id) {
      failed.push(campaign.name);
      continue;
    }

    try {
      await client.pauseCampaign(campaign.platform_campaign_id);
      paused.push(campaign.name);
    } catch {
      failed.push(campaign.name);
    }
  }

  return { paused, failed };
}
