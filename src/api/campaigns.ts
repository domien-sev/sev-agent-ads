import type { AdCampaignRecord, AdPlatform, CampaignObjective, TargetingSpec } from "@domien-sev/shared-types";
import type { AdsAgent } from "../agent.js";
import type { ApiRouter } from "./router.js";
import { getClient, readItems, createItem, updateItem } from "../lib/directus.js";
import { publishCampaign } from "../pipeline/publish.js";

export function registerCampaignRoutes(router: ApiRouter, agent: AdsAgent) {
  /**
   * GET /api/campaigns?status=X&platform=X&limit=50&offset=0
   * List campaigns with optional filters.
   */
  router.get("/api/campaigns", async (req) => {
    const { status, platform, limit: limitStr, offset: offsetStr } = req.query;
    const limit = Math.min(parseInt(limitStr || "50", 10), 100);
    const offset = parseInt(offsetStr || "0", 10);

    const filter: Record<string, unknown> = {};
    if (status) filter.status = { _eq: status };
    if (platform) filter.platform = { _eq: platform };

    const client = getClient(agent);
    const campaigns = await client.request(
      readItems("ad_campaigns", {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        limit,
        offset,
        sort: ["-date_created"],
      }),
    ) as AdCampaignRecord[];

    return { status: 200, data: { items: campaigns, limit, offset } };
  });

  /**
   * POST /api/campaigns
   * Body: { name, platform, objective, daily_budget, targeting, schedule_start, schedule_end?, creative_ids?, product_ids? }
   * Create a new campaign (status: pending_approval).
   */
  router.post("/api/campaigns", async (req) => {
    const body = req.body as CreateCampaignInput;

    if (!body?.name || !body?.platform || !body?.daily_budget) {
      return { status: 400, data: { error: "name, platform, and daily_budget are required" } };
    }

    const client = getClient(agent);

    // If no creative_ids provided, grab all approved unassigned creatives for this platform
    let creativeIds = body.creative_ids ?? [];
    if (creativeIds.length === 0) {
      const available = await client.request(
        readItems("ad_creatives", {
          filter: {
            status: { _eq: "approved" },
            campaign_id: { _null: true },
            platform_target: { _contains: body.platform },
          },
          fields: ["id"],
          limit: 50,
        }),
      ) as { id: string }[];
      creativeIds = available.map((c) => c.id);
    }

    const campaign = await client.request(
      createItem("ad_campaigns", {
        name: body.name,
        group_id: null,
        platform: body.platform,
        platform_campaign_id: null,
        platform_adset_id: null,
        objective: body.objective ?? "conversions",
        daily_budget: body.daily_budget,
        total_budget: body.total_budget ?? null,
        targeting: body.targeting ?? {},
        schedule_start: body.schedule_start ?? new Date().toISOString().split("T")[0],
        schedule_end: body.schedule_end ?? null,
        product_ids: body.product_ids ?? [],
        creative_ids: creativeIds,
        status: "pending_approval",
        approval_notes: null,
      }),
    ) as AdCampaignRecord;

    // Assign creatives to this campaign
    for (const cid of creativeIds) {
      await client.request(updateItem("ad_creatives", cid, { campaign_id: campaign.id }));
    }

    return {
      status: 201,
      data: {
        campaign,
        creatives_assigned: creativeIds.length,
      },
    };
  });

  /**
   * PATCH /api/campaigns/:id
   * Body: { action: "approve" | "publish" | "pause" | "resume" | "archive", approval_notes?: string }
   * Update campaign status / trigger publishing.
   */
  router.patch("/api/campaigns/:id", async (req) => {
    const { id } = req.params;
    const { action, approval_notes } = (req.body as {
      action?: string;
      approval_notes?: string;
    }) ?? {};

    if (!action) {
      return { status: 400, data: { error: "action is required (approve, publish, pause, resume, archive)" } };
    }

    const client = getClient(agent);

    // Fetch the campaign
    const campaigns = await client.request(
      readItems("ad_campaigns", { filter: { id: { _eq: id } }, limit: 1 }),
    ) as AdCampaignRecord[];

    if (campaigns.length === 0) {
      return { status: 404, data: { error: "Campaign not found" } };
    }

    const campaign = campaigns[0];

    switch (action) {
      case "approve": {
        await client.request(updateItem("ad_campaigns", id, {
          status: "approved",
          approval_notes: approval_notes ?? null,
        }));
        return { status: 200, data: { id, status: "approved" } };
      }

      case "publish": {
        if (campaign.status !== "approved") {
          return { status: 400, data: { error: `Cannot publish campaign with status '${campaign.status}'. Approve it first.` } };
        }
        const result = await publishCampaign(agent, { ...campaign, status: "approved" });
        return { status: 200, data: result };
      }

      case "pause": {
        await client.request(updateItem("ad_campaigns", id, { status: "paused" }));
        // TODO: also pause on platform via API
        return { status: 200, data: { id, status: "paused" } };
      }

      case "resume": {
        await client.request(updateItem("ad_campaigns", id, { status: "active" }));
        return { status: 200, data: { id, status: "active" } };
      }

      case "archive": {
        await client.request(updateItem("ad_campaigns", id, { status: "archived" }));
        return { status: 200, data: { id, status: "archived" } };
      }

      default:
        return { status: 400, data: { error: `Unknown action: ${action}` } };
    }
  });
}

interface CreateCampaignInput {
  name: string;
  platform: AdPlatform;
  objective?: CampaignObjective;
  daily_budget: number;
  total_budget?: number;
  targeting?: TargetingSpec;
  schedule_start?: string;
  schedule_end?: string;
  creative_ids?: string[];
  product_ids?: string[];
}
