/**
 * Directus helpers that bypass strict SDK v18 generics.
 * The SDK rejects collection names not in the inferred schema at the call site.
 * These wrappers cast through `any` so ad_* collection names are accepted.
 */

import {
  createItem as _createItem,
  readItems as _readItems,
  updateItem as _updateItem,
  deleteItems as _deleteItems,
} from "@directus/sdk";
import type { AdsAgent } from "../agent.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = { request: (query: any) => Promise<any> };

export function getClient(agent: AdsAgent): AnyClient {
  return agent.directus.getClient("sev-ai") as unknown as AnyClient;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readItems = _readItems as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createItem = _createItem as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateItem = _updateItem as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deleteItems = _deleteItems as any;
