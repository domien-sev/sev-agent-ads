/**
 * Ad group helpers — find or create groups from events or evergreen campaigns.
 */
import type { AdsAgent } from "../agent.js";
import { getClient, createItem, readItems } from "./directus.js";

export interface EventInfo {
  id: string;
  name: string;
  startDate?: string | null;
  endDate?: string | null;
  brands?: string[];
}

/**
 * Find an existing ad_group for an event, or create one.
 * Returns the group ID.
 */
export async function findOrCreateEventGroup(
  agent: AdsAgent,
  event: EventInfo,
): Promise<string> {
  const client = getClient(agent);

  // Check if a group already exists for this event
  const existing = await client.request(
    readItems("ad_groups", {
      filter: {
        event_id: { _eq: event.id },
        type: { _eq: "event" },
      },
      limit: 1,
    }),
  ) as Array<{ id: string }>;

  if (existing.length > 0) {
    return existing[0].id;
  }

  // Create new group
  const group = await client.request(
    createItem("ad_groups", {
      name: event.name,
      type: "event",
      event_id: event.id,
      event_name: event.name,
      event_start: event.startDate ?? null,
      event_end: event.endDate ?? null,
      brands: event.brands ?? [],
      status: "active",
    }),
  ) as { id: string };

  agent.log.info(`Created ad_group "${event.name}" for event ${event.id}`);
  return group.id;
}

/**
 * Find an existing evergreen group by name, or create one.
 */
export async function findOrCreateEvergreenGroup(
  agent: AdsAgent,
  name: string,
  brands?: string[],
): Promise<string> {
  const client = getClient(agent);

  const existing = await client.request(
    readItems("ad_groups", {
      filter: {
        name: { _eq: name },
        type: { _eq: "evergreen" },
      },
      limit: 1,
    }),
  ) as Array<{ id: string }>;

  if (existing.length > 0) {
    return existing[0].id;
  }

  const group = await client.request(
    createItem("ad_groups", {
      name,
      type: "evergreen",
      event_id: null,
      event_name: null,
      event_start: null,
      event_end: null,
      brands: brands ?? [],
      status: "active",
    }),
  ) as { id: string };

  agent.log.info(`Created evergreen ad_group "${name}"`);
  return group.id;
}
