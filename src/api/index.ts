import type { AdsAgent } from "../agent.js";
import { ApiRouter } from "./router.js";
import { registerProductRoutes } from "./products.js";
import { registerCreativeRoutes } from "./creatives.js";
import { registerCampaignRoutes } from "./campaigns.js";
import { registerPerformanceRoutes } from "./performance.js";

export function createApiRouter(agent: AdsAgent): ApiRouter {
  const router = new ApiRouter();

  registerProductRoutes(router, agent);
  registerCreativeRoutes(router, agent);
  registerCampaignRoutes(router, agent);
  registerPerformanceRoutes(router, agent);

  return router;
}

export { ApiRouter } from "./router.js";
