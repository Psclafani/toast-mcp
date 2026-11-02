// /menus/v2/menus returns a document ({ menus: [...] }), not a bare array, and
// inside it groups are `menuGroups` (nested) and items are `menuItems`. The
// fixture below is shaped after a real Montrose document. Run: npm test
// (builds first, then node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerMenusTools, fetchMenus, allItems } from '../dist/tools/menus.js';
import { registerInventoryTools } from '../dist/tools/inventory.js';

const item = (guid, name, extra = {}) => ({ guid, name, price: 10, ...extra });
const largeVeg = item('it-veg-l', 'LARGE A VEG SUPREME (V)', { price: 18 });
const smallVeg = item('it-veg-s', 'SMALL A VEG SUPREME (V)', { price: 12 });

const menusDocument = {
  restaurantGuid: 'rest-1',
  lastUpdated: '2026-09-18T21:00:35.917+0000',
  restaurantTimeZone: 'America/Chicago',
  menus: [
    {
      guid: 'menu-food', name: 'FOOD MENU', visibility: ['POS'],
      menuGroups: [
        { guid: 'grp-large', name: 'LARGE PIZZA', menuGroups: [], menuItems: [
          item('it-pepps', 'LARGE PEPPS', { sku: 'PEP-L' }),
          largeVeg,
        ] },
        { guid: 'grp-small', name: 'SMALL PIZZA', menuGroups: [], menuItems: [smallVeg] },
      ],
    },
    {
      // A second menu that lists the same item guid (dine-in vs 3PD copy).
      guid: 'menu-food-3pd', name: 'Food', visibility: ['ORDERING_PARTNERS'],
      menuGroups: [
        { guid: 'grp-large-3pd', name: 'LARGE PIZZA', menuGroups: [], menuItems: [largeVeg] },
      ],
    },
    {
      // Nested sub-groups, the way the Drinks menu is built.
      guid: 'menu-drinks', name: 'Drinks', visibility: ['POS'],
      menuGroups: [
        { guid: 'grp-beer', name: 'Beer', menuItems: [], menuGroups: [
          { guid: 'grp-draft', name: 'Draft', menuGroups: [], menuItems: [
            item('it-lager', 'Lager', { plu: '9001' }),
          ] },
        ] },
      ],
    },
    { guid: 'menu-empty', name: 'Happy Hour', visibility: ['POS'], menuGroups: [] },
  ],
  modifierGroupReferences: {},
  modifierOptionReferences: {},
  preModifierGroupReferences: {},
};

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    getRestaurantGuid: () => 'rest-1',
    async get(endpoint, params) {
      calls.push({ endpoint, params });
      return typeof response === 'function' ? response(endpoint) : response;
    },
    async patch() { throw new Error('not expected'); },
    async put() { throw new Error('not expected'); },
    async post() { throw new Error('not expected'); },
  };
}

const toolsFor = (client) => Object.fromEntries(registerMenusTools(client).map(t => [t.name, t]));

test('fetchMenus unwraps the document', async () => {
  const menus = await fetchMenus(fakeClient(menusDocument), 'rest-1');
  assert.deepEqual(menus.map(m => m.guid), ['menu-food', 'menu-food-3pd', 'menu-drinks', 'menu-empty']);
});

test('fetchMenus still accepts a bare array (older shape)', async () => {
  const menus = await fetchMenus(fakeClient(menusDocument.menus), 'rest-1');
  assert.equal(menus.length, 4);
});

test('fetchMenus throws a clear error when there is no menus array', async () => {
  for (const bad of [{}, { menus: 'nope' }, null, 'html error page']) {
    await assert.rejects(
      fetchMenus(fakeClient(bad), 'rest-1'),
      /Unexpected \/menus\/v2\/menus response: no menus array/
    );
  }
});

test('allItems walks nested menuGroups/menuItems and the legacy groups/items spelling', () => {
  const guids = allItems(menusDocument.menus).map(i => i.guid);
  assert.deepEqual(guids, ['it-pepps', 'it-veg-l', 'it-veg-s', 'it-veg-l', 'it-lager']);

  const legacy = [{ guid: 'm', name: 'M', groups: [{ guid: 'g', name: 'G', items: [item('x', 'X')] }] }];
  assert.deepEqual(allItems(legacy).map(i => i.guid), ['x']);
});

test('toast_list_menus unwraps the document and reports count', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const out = await tools.toast_list_menus.handler({});
  assert.equal(out.count, 4);
  assert.deepEqual(out.menus.map(m => m.name), ['FOOD MENU', 'Food', 'Drinks', 'Happy Hour']);
});

test('toast_search_menu_items matches by name across menus and returns each guid once', async () => {
  const client = fakeClient(menusDocument);
  const tools = toolsFor(client);
  const out = await tools.toast_search_menu_items.handler({ query: 'veg supreme' });
  assert.equal(out.count, 2);
  assert.deepEqual(out.items.map(i => i.guid), ['it-veg-l', 'it-veg-s']);
  // the large pizza sits on two menus; both placements are reported
  assert.deepEqual(out.items[0].foundIn.map(p => `${p.menuName} / ${p.menuGroupName}`),
    ['FOOD MENU / LARGE PIZZA', 'Food / LARGE PIZZA']);
  assert.equal(out.items[0].foundIn[0].menuGroupGuid, 'grp-large');
  // one document fetch, with the restaurant routed through params
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].endpoint, '/menus/v2/menus');
  assert.equal(client.calls[0].params.restaurantGuid, 'rest-1');
});

test('toast_search_menu_items matches sku and plu, including items in nested groups', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const bySku = await tools.toast_search_menu_items.handler({ query: 'pep-l' });
  assert.deepEqual(bySku.items.map(i => i.guid), ['it-pepps']);
  const byPlu = await tools.toast_search_menu_items.handler({ query: '9001' });
  assert.deepEqual(byPlu.items.map(i => i.guid), ['it-lager']);
  assert.equal(byPlu.items[0].foundIn[0].menuGroupName, 'Draft');
  const none = await tools.toast_search_menu_items.handler({ query: 'no such item' });
  assert.deepEqual(none, { items: [], count: 0 });
});

test('toast_search_menu_items passes an explicit restaurantGuid through', async () => {
  const client = fakeClient(menusDocument);
  const tools = toolsFor(client);
  await tools.toast_search_menu_items.handler({ query: 'lager', restaurantGuid: 'rest-2' });
  assert.equal(client.calls[0].params.restaurantGuid, 'rest-2');
});

test('toast_get_menu and toast_get_menu_item select from the document', async () => {
  const client = fakeClient(menusDocument);
  const tools = toolsFor(client);
  const menu = await tools.toast_get_menu.handler({ menuGuid: 'menu-drinks' });
  assert.equal(menu.menu.name, 'Drinks');
  const it = await tools.toast_get_menu_item.handler({ itemGuid: 'it-lager' });
  assert.equal(it.item.name, 'Lager');
  assert.ok(client.calls.every(c => c.endpoint === '/menus/v2/menus'), 'no per-object endpoints');
  await assert.rejects(tools.toast_get_menu.handler({ menuGuid: 'missing' }), /Menu missing not found/);
  await assert.rejects(tools.toast_get_menu_item.handler({ itemGuid: 'missing' }), /Menu item missing not found/);
});

test('toast_list_menu_groups flattens nested groups, per menu and overall', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const drinks = await tools.toast_list_menu_groups.handler({ menuGuid: 'menu-drinks' });
  assert.deepEqual(drinks.groups.map(g => g.name), ['Beer', 'Draft']);
  const all = await tools.toast_list_menu_groups.handler({});
  assert.equal(all.count, 5);
  await assert.rejects(tools.toast_list_menu_groups.handler({ menuGuid: 'missing' }), /Menu missing not found/);
});

test('toast_get_items_by_category finds nested groups', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const out = await tools.toast_get_items_by_category.handler({ groupGuid: 'grp-draft' });
  assert.equal(out.groupName, 'Draft');
  assert.deepEqual(out.items.map(i => i.guid), ['it-lager']);
  await assert.rejects(tools.toast_get_items_by_category.handler({ groupGuid: 'missing' }), /Menu group missing not found/);
});

test('toast_get_86d_items finds 86d items in nested groups', async () => {
  const doc = {
    menus: [{
      guid: 'm', name: 'M', menuGroups: [
        { guid: 'g', name: 'G', menuItems: [item('a', 'A', { outOfStock86: true }), item('b', 'B')],
          menuGroups: [{ guid: 'g2', name: 'G2', menuItems: [item('c', 'C', { inheritedOutOfStock86: true })] }] },
      ],
    }],
  };
  const tools = toolsFor(fakeClient(doc));
  const out = await tools.toast_get_86d_items.handler({});
  assert.deepEqual(out.items.map(i => i.guid), ['a', 'c']);
});

test('toast_list_low_stock_items iterates nested items once each', async () => {
  const client = fakeClient((endpoint) => {
    if (endpoint === '/menus/v2/menus') return menusDocument;
    const guid = endpoint.split('/').pop();
    return { guid, quantity: guid === 'it-lager' ? 0 : 5, infiniteQuantity: false, outOfStock: guid === 'it-lager' };
  });
  const tools = Object.fromEntries(registerInventoryTools(client).map(t => [t.name, t]));
  const out = await tools.toast_list_low_stock_items.handler({});
  assert.deepEqual(out.items.map(i => i.itemGuid), ['it-lager']);
  const stockCalls = client.calls.filter(c => c.endpoint !== '/menus/v2/menus').map(c => c.endpoint);
  assert.equal(stockCalls.length, new Set(stockCalls).size, 'each item checked once');
});
