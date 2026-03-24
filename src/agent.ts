import { BaseAgent } from "@domien-sev/agent-sdk";
import type { AgentConfig } from "@domien-sev/agent-sdk";
import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import { ShopifyAdminClient } from "@domien-sev/shopify-sdk";
import { CreatomateClient, ImageGenerator, VideoGenerator, BackgroundRemover, AssetStorage } from "@domien-sev/creative-sdk";
import { MetaAdsClient, GoogleAdsClient, TikTokAdsClient, PinterestAdsClient, PerformanceCollector } from "@domien-sev/ads-sdk";

import { handleGenerate } from "./handlers/generate.js";
import { handleCampaign } from "./handlers/campaign.js";
import { handleReport } from "./handlers/report.js";
import { handleOptimize } from "./handlers/optimize.js";

export class AdsAgent extends BaseAgent {
  public shopifyClient!: ShopifyAdminClient;
  public creatomate!: CreatomateClient;
  public imageGenerator!: ImageGenerator;
  public videoGenerator!: VideoGenerator;
  public bgRemover!: BackgroundRemover;
  public storage!: AssetStorage;
  public performanceCollector!: PerformanceCollector;
  public metaAds?: MetaAdsClient;
  public googleAds?: GoogleAdsClient;
  public tiktokAds?: TikTokAdsClient;
  public pinterestAds?: PinterestAdsClient;

  /** Pagination state for "generate more" */
  public lastQuery: string = "";
  public lastOffset: number = 0;
  public lastTotalMatches: number = 0;

  constructor(config: AgentConfig) {
    super(config);
  }

  async onStart(): Promise<void> {
    this.logger.info("Initializing ads agent...");

    // Initialize Shopify client (prefer client credentials for auto-refresh)
    if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
      this.shopifyClient = new ShopifyAdminClient({
        shop: process.env.SHOPIFY_SHOP ?? "",
        clientId: process.env.SHOPIFY_CLIENT_ID,
        clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
      });
    } else {
      this.shopifyClient = new ShopifyAdminClient({
        shop: process.env.SHOPIFY_SHOP ?? "",
        accessToken: process.env.SHOPIFY_ACCESS_TOKEN ?? "",
      });
    }

    // Initialize creative generation
    if (process.env.CREATOMATE_API_KEY) {
      this.creatomate = new CreatomateClient({ apiKey: process.env.CREATOMATE_API_KEY });
    }

    this.imageGenerator = new ImageGenerator({
      ...(process.env.FLUX_API_KEY && {
        flux: {
          apiKey: process.env.FLUX_API_KEY,
          backend: (process.env.FLUX_BACKEND as "bfl" | "openrouter" | undefined) ?? "bfl",
          model: process.env.FLUX_MODEL,
        },
      }),
      ...(process.env.RECRAFT_API_KEY && { recraft: { apiKey: process.env.RECRAFT_API_KEY } }),
      ...(process.env.OPENAI_API_KEY && { openai: { apiKey: process.env.OPENAI_API_KEY } }),
    });

    this.videoGenerator = new VideoGenerator({
      ...(process.env.CREATIFY_API_KEY && { creatify: { apiKey: process.env.CREATIFY_API_KEY } }),
      ...(process.env.HEYGEN_API_KEY && { heygen: { apiKey: process.env.HEYGEN_API_KEY } }),
      ...(process.env.RUNWAY_API_KEY && { runway: { apiKey: process.env.RUNWAY_API_KEY } }),
    });

    if (process.env.PHOTOROOM_API_KEY) {
      this.bgRemover = new BackgroundRemover({ apiKey: process.env.PHOTOROOM_API_KEY });
    }

    // Initialize S3-compatible asset storage (Hetzner Object Storage, R2, etc.)
    this.storage = new AssetStorage({
      endpoint: process.env.S3_ENDPOINT ?? "",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      bucket: process.env.S3_BUCKET ?? "sev-ads-creatives",
      publicUrl: process.env.S3_PUBLIC_URL,
      region: process.env.S3_REGION,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    });

    // Initialize ad platform clients
    this.performanceCollector = new PerformanceCollector();

    if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
      this.metaAds = new MetaAdsClient({
        accessToken: process.env.META_ACCESS_TOKEN,
        adAccountId: process.env.META_AD_ACCOUNT_ID,
      });
      this.performanceCollector.registerClient(this.metaAds);
    }

    if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      this.googleAds = new GoogleAdsClient({
        developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        clientId: process.env.GOOGLE_ADS_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET ?? "",
        refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
        customerId: process.env.GOOGLE_ADS_CUSTOMER_ID ?? "",
      });
      this.performanceCollector.registerClient(this.googleAds);
    }

    if (process.env.TIKTOK_ACCESS_TOKEN && process.env.TIKTOK_ADVERTISER_ID) {
      this.tiktokAds = new TikTokAdsClient({
        accessToken: process.env.TIKTOK_ACCESS_TOKEN,
        advertiserId: process.env.TIKTOK_ADVERTISER_ID,
      });
      this.performanceCollector.registerClient(this.tiktokAds);
    }

    if (process.env.PINTEREST_ACCESS_TOKEN && process.env.PINTEREST_AD_ACCOUNT_ID) {
      this.pinterestAds = new PinterestAdsClient({
        accessToken: process.env.PINTEREST_ACCESS_TOKEN,
        adAccountId: process.env.PINTEREST_AD_ACCOUNT_ID,
      });
      this.performanceCollector.registerClient(this.pinterestAds);
    }

    this.logger.info(`Ads agent started. Image providers: ${this.imageGenerator.availableProviders.join(", ")}. Video providers: ${this.videoGenerator.availableProviders.join(", ")}`);
  }

  async onStop(): Promise<void> {
    this.logger.info("Ads agent stopped");
  }

  async handleMessage(message: RoutedMessage): Promise<AgentResponse> {
    const text = message.text.trim().toLowerCase();
    this.logger.info(`Received: "${text}" from ${message.user_id}`);

    try {
      // Route to handlers based on command keywords
      if (text === "generate more" || text === "more") {
        return handleGenerate(this, message, true);
      }

      if (text.startsWith("generate") || text.startsWith("create ads") || text.startsWith("make ads")) {
        return handleGenerate(this, message);
      }

      if (text.startsWith("campaign") || text.startsWith("create campaign") || text.startsWith("launch")) {
        return handleCampaign(this, message);
      }

      if (text.startsWith("report") || text.startsWith("performance") || text.startsWith("stats")) {
        return handleReport(this, message);
      }

      if (text.startsWith("optimize") || text.startsWith("scale") || text.startsWith("pause")) {
        return handleOptimize(this, message);
      }

      if (text === "help" || text === "?") {
        return this.helpResponse(message);
      }

      // Default: show help
      return this.helpResponse(message);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
      this.logger.error(`Handler error: ${errMsg}`);
      return {
        channel_id: message.channel_id,
        thread_ts: message.thread_ts ?? message.ts,
        text: `Error: ${errMsg}`,
      };
    }
  }

  private helpResponse(message: RoutedMessage): AgentResponse {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: [
        "*Ad Agent Commands:*",
        "",
        "`generate ads for [product/brand/URL]` — Generate creatives (first 10 matches)",
        "`generate more` — Continue with the next 10 products from the last search",
        "`create campaign [name] on [platform]` — Set up a new ad campaign",
        "`report [daily/weekly]` — Performance summary",
        "`performance [campaign name]` — Detailed campaign metrics",
        "`optimize` — Run optimization rules (pause underperformers, scale winners)",
        "`pause [campaign]` — Pause a campaign",
        "`help` — Show this message",
      ].join("\n"),
    };
  }
}
