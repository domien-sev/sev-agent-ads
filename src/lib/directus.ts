/**
 * Typed Directus helpers that bypass strict SDK generics.
 * The @directus/sdk v18 typing rejects collection names that aren't
 * in the inferred schema at the call site. Since our SevAiSchema
 * includes these collections, this is safe.
 */

import { createItem, readItems, updateItem, deleteItems } from "@directus/sdk";
import type { AdsAgent } from "../agent.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = { request: (query: any) => Promise<any> };

export function getClient(agent: AdsAgent): AnyClient {
  return agent.directus.getClient("sev-ai") as unknown as AnyClient;
}

export { createItem, readItems, updateItem, deleteItems };
