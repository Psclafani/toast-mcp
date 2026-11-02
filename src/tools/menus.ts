import { z } from 'zod';
import { ToastClient } from '../clients/toast.js';
import type { Menu, MenuGroup, MenuItem, ModifierGroup } from '../types/index.js';

/**
 * Menu Management Tools - comprehensive menu, item, and modifier operations
 */

/**
 * GET /menus/v2/menus returns a document, not a bare array: the menus live
 * under `.menus` next to lastUpdated, restaurantTimeZone and the modifier
 * reference maps. Inside it a menu holds `menuGroups`, and a group holds
 * `menuItems` plus nested `menuGroups` (sub-groups can go several levels
 * deep). Every tool that walks menus goes through these helpers so the shape
 * is handled in one place.
 */
interface MenusDocument {
  restaurantGuid?: string;
  lastUpdated?: string;
  restaurantTimeZone?: string;
  menus: Menu[];
}

export async function fetchMenus(client: ToastClient, restaurantGuid: string): Promise<Menu[]> {
  const res = await client.get<MenusDocument | Menu[]>(
    `/menus/v2/menus`,
    { restaurantGuid }
  );
  const menus = Array.isArray(res) ? res : res?.menus;
  if (!Array.isArray(menus)) {
    const shape = res === null || res === undefined ? String(res) : typeof res;
    throw new Error(`Unexpected /menus/v2/menus response: no menus array (got ${shape})`);
  }
  return menus;
}

/** Direct child groups of a menu or group, whichever spelling the payload uses. */
export function menuGroupsOf(node: { menuGroups?: MenuGroup[]; groups?: MenuGroup[] }): MenuGroup[] {
  return node.menuGroups ?? node.groups ?? [];
}

/** Items directly in a group, whichever spelling the payload uses. */
export function menuItemsOf(group: MenuGroup): MenuItem[] {
  return group.menuItems ?? group.items ?? [];
}

/** Every group in a menu, depth first, including nested sub-groups. */
export function allGroups(menu: Menu): MenuGroup[] {
  const out: MenuGroup[] = [];
  const walk = (groups: MenuGroup[]) => {
    for (const group of groups) {
      out.push(group);
      walk(menuGroupsOf(group));
    }
  };
  walk(menuGroupsOf(menu));
  return out;
}

/** Every item across every menu and nested group. */
export function allItems(menus: Menu[]): MenuItem[] {
  return menus.flatMap(menu => allGroups(menu).flatMap(menuItemsOf));
}

export function registerMenusTools(client: ToastClient) {
  return [
    {
      name: 'toast_list_menus',
      description: 'List all menus for a restaurant',
      inputSchema: z.object({
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);
        return { menus, count: menus.length };
      },
    },

    {
      name: 'toast_get_menu',
      description: 'Get detailed information about a specific menu including all groups and items',
      inputSchema: z.object({
        menuGuid: z.string(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { menuGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        // Menus v2 has no per-menu endpoint (404); pull the document and select.
        const menus = await fetchMenus(client, restGuid);
        const menu = menus.find(m => m.guid === args.menuGuid);
        if (!menu) {
          throw new Error(`Menu ${args.menuGuid} not found`);
        }
        return { menu };
      },
    },

    {
      name: 'toast_get_menu_item',
      description: 'Get detailed information about a specific menu item',
      inputSchema: z.object({
        itemGuid: z.string(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        // Menus v2 has no per-item endpoint (404); pull the document and select.
        const menus = await fetchMenus(client, restGuid);
        const item = allItems(menus).find(i => i.guid === args.itemGuid);
        if (!item) {
          throw new Error(`Menu item ${args.itemGuid} not found`);
        }
        return { item };
      },
    },

    {
      name: 'toast_search_menu_items',
      description: 'Search menu items by name, SKU, or PLU',
      inputSchema: z.object({
        query: z.string().describe('Search query (name, SKU, or PLU)'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { query: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        const query = args.query.toLowerCase();
        const matches = (item: MenuItem) =>
          item.name?.toLowerCase().includes(query) ||
          item.sku?.toLowerCase().includes(query) ||
          item.plu?.toLowerCase().includes(query);

        // The same item guid shows up under every menu that lists it (a
        // dine-in and a to-go menu, say), so return each item once and record
        // where it was found.
        type Placement = { menuGuid: string; menuName: string; menuGroupGuid: string; menuGroupName: string };
        const found = new Map<string, MenuItem & { foundIn: Placement[] }>();
        for (const menu of menus) {
          for (const group of allGroups(menu)) {
            for (const item of menuItemsOf(group)) {
              if (!matches(item)) continue;
              const placement: Placement = {
                menuGuid: menu.guid,
                menuName: menu.name,
                menuGroupGuid: group.guid,
                menuGroupName: group.name,
              };
              const seen = found.get(item.guid);
              if (seen) {
                seen.foundIn.push(placement);
              } else {
                found.set(item.guid, { ...item, foundIn: [placement] });
              }
            }
          }
        }

        const matchingItems = [...found.values()];
        return { items: matchingItems, count: matchingItems.length };
      },
    },

    {
      name: 'toast_update_item_price',
      description: 'Update the price of a menu item',
      inputSchema: z.object({
        itemGuid: z.string(),
        price: z.number().describe('New price in cents (e.g., 1250 for $12.50)'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuid: string; price: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const result = await client.patch(
          `/menus/v2/items/${args.itemGuid}`,
          { price: args.price },
          { params: { restaurantGuid: restGuid } }
        );
        return { success: true, result };
      },
    },

    {
      name: 'toast_set_item_86',
      description: 'Mark an item as out of stock (86\'d) or back in stock',
      inputSchema: z.object({
        itemGuid: z.string(),
        outOfStock: z.boolean().describe('true to mark 86\'d, false to mark available'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuid: string; outOfStock: boolean; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const result = await client.patch(
          `/menus/v2/items/${args.itemGuid}`,
          { outOfStock86: args.outOfStock },
          { params: { restaurantGuid: restGuid } }
        );
        return { success: true, itemGuid: args.itemGuid, outOfStock: args.outOfStock };
      },
    },

    {
      name: 'toast_get_modifier_group',
      description: 'Get details about a modifier group (e.g., toppings, sides)',
      inputSchema: z.object({
        modifierGroupGuid: z.string(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { modifierGroupGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const modifierGroup = await client.get<ModifierGroup>(
          `/menus/v2/modifierGroups/${args.modifierGroupGuid}`,
          { restaurantGuid: restGuid }
        );
        return { modifierGroup };
      },
    },

    {
      name: 'toast_list_menu_groups',
      description: 'List all menu groups (categories) across all menus',
      inputSchema: z.object({
        menuGuid: z.string().optional().describe('Filter by specific menu GUID'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { menuGuid?: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        if (args.menuGuid) {
          const menu = menus.find(m => m.guid === args.menuGuid);
          if (!menu) {
            throw new Error(`Menu ${args.menuGuid} not found`);
          }
          const groups = allGroups(menu);
          return { groups, count: groups.length };
        }

        const groups = menus.flatMap(allGroups);
        return { groups, count: groups.length };
      },
    },

    {
      name: 'toast_get_items_by_category',
      description: 'Get all menu items in a specific category/group',
      inputSchema: z.object({
        groupGuid: z.string().describe('Menu group GUID'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { groupGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        let foundGroup: MenuGroup | undefined;
        for (const menu of menus) {
          foundGroup = allGroups(menu).find(g => g.guid === args.groupGuid);
          if (foundGroup) break;
        }

        if (!foundGroup) {
          throw new Error(`Menu group ${args.groupGuid} not found`);
        }

        const items = menuItemsOf(foundGroup);
        return { items, groupName: foundGroup.name, count: items.length };
      },
    },

    {
      name: 'toast_get_86d_items',
      description: 'Get all items currently marked as out of stock (86\'d)',
      inputSchema: z.object({
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        const outOfStockItems = allItems(menus).filter(item => item.outOfStock86 || item.inheritedOutOfStock86);

        return { items: outOfStockItems, count: outOfStockItems.length };
      },
    },

    {
      name: 'toast_bulk_86_items',
      description: 'Mark multiple items as out of stock (86\'d) at once',
      inputSchema: z.object({
        itemGuids: z.array(z.string()),
        outOfStock: z.boolean(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuids: string[]; outOfStock: boolean; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const results = await Promise.all(
          args.itemGuids.map(itemGuid =>
            client.patch(
              `/menus/v2/items/${itemGuid}`,
              { outOfStock86: args.outOfStock },
              { params: { restaurantGuid: restGuid } }
            ).catch(err => ({ error: err.message, itemGuid }))
          )
        );

        const successful = results.filter(r => !(r && typeof r === 'object' && 'error' in r));
        const failed = results.filter(r => r && typeof r === 'object' && 'error' in r);

        return {
          successCount: successful.length,
          failCount: failed.length,
          failed: failed,
        };
      },
    },
  ];
}
