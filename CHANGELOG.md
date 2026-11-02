# Changelog

Check your deployed version at `https://<your-domain>/health`.

## 1.2.2 (2026-10-08)

- **Menu tools now read the real Menus v2 shape.** 1.2.1 unwrapped the
  `{ menus: [...] }` document but still walked `groups` and `items`. Toast
  names them `menuGroups` (nested, up to three deep) and `menuItems`, so on live
  data `toast_search_menu_items` returned 0 items, `toast_list_menu_groups`
  and `toast_get_items_by_category` came back empty, and
  `toast_get_86d_items` and `toast_list_low_stock_items` missed everything.
  All menu walks now go through `allGroups()` / `allItems()`, which follow
  nested groups and still accept the old `groups`/`items` spelling.
- **`toast_search_menu_items` returns each item once.** The same item guid sits
  on every menu that lists it, so results are deduped by guid with a
  `foundIn` list of `{ menuGuid, menuName, menuGroupGuid, menuGroupName }`.
- **`toast_list_low_stock_items`** checks each item guid once, including items
  in nested groups.
- **Types** use `menuGroups` / `menuItems` (legacy spellings kept optional).
- **Tests:** `test/menus.test.mjs` now uses a fixture shaped after a live
  document (nested groups, an item on two menus, an empty menu).

## 1.2.1 (2026-09-16)

Both fixes come from production reports by @luizggonsales (issues #1 and #2).

- **Sales summary no longer double-counts check-level discounts** (#1).
  `check.amount` is already net of check-level discounts, but the summary
  subtracted them again, so `netSales` came in low by exactly the check-level
  discount total. Gross is now rebuilt by adding every discount back onto
  `check.amount`, and an applied discount that appears on both the check and
  its selections is counted once. The discount report dedupes the same way so
  the two tools still agree.
- **Menu tools work again** (#2). `GET /menus/v2/menus` returns a document with
  the menus under `.menus`; the tools treated it as a bare array, so
  `toast_list_menu_groups`, `toast_search_menu_items`, `toast_get_items_by_category`,
  `toast_get_86d_items` and `toast_list_low_stock_items` threw
  `menus.flatMap is not a function`, and `toast_list_menus` returned the
  container with `count: undefined`. All of them now unwrap the document.
  `toast_get_menu` and `toast_get_menu_item` called per-object endpoints that
  Menus v2 does not have; they now select from the document instead.
- **Unit tests added** (`npm test`): fake-client tests for the menu tools and
  the discount arithmetic, alongside the live gauntlet.

## 1.2.0 (2026-09-01)

Every fix below was found by testing against live production restaurants and is
verified by the new validation gauntlet (`npm run validate:live`), which now
passes 12/12 against a real account.

- **Item sales report rebuilt.** It previously collapsed every selection into a
  single arbitrary bucket (grouping on a field Toast never populates), reported
  discount-net prices as gross, and subtracted discounts twice. It now groups on
  the menu item reference, sums preDiscountPrice as gross, and reports price as
  net. Real per-item results for the first time.
- **Discount report counts item-level comps.** Loyalty rewards and single-item
  discounts live on the selection, not the check, and were invisible. The report
  now reconciles to manager logs to the cent, and no longer emits literal
  "undefined" discount ids.
- **Sales summary counts item-level comps** the same way, so discountAmount and
  grossSales agree with the discount report and with Toast Web.
- **Schema fix for every optional numeric parameter.** Optional numbers were
  advertised as strings and then rejected ("Expected number, received string"),
  making those parameters unreachable. The advertised schema now matches
  validation, and numeric strings from older clients are coerced.
- **Pagination is concurrent and capped.** Order-scanning tools fetch pages in
  batches of 4 with a 60-page safety cap, ending multi-minute hangs on
  customer search, loyalty, and top-customer tools. Scan windows tightened.
- **Validation gauntlet added** (`scripts/validate-live.mjs`): schema sweep of
  every read tool plus arithmetic invariants (hourly sums to the day, gross
  minus discounts equals net, discount report equals summary, item gross >= net).

## 1.1.1 (2026-08-30)

- Per-call `restaurantGuid` override fixed (auth interceptor no longer stomps
  the Toast-Restaurant-External-ID header). Multi-location queries work.
- Named locations: set `TOAST_LOCATIONS` to {"Name": "guid", ...} and every
  tool accepts location names; adds `toast_get_locations`.

## 1.1.0 (2026-08-30)

- Remote mode: streamable HTTP transport with shared-secret auth for use as a
  claude.ai custom connector. Write tools disabled by default; three-lock
  safety (env flag, dry-run default, per-call confirm_write) when enabled.

## 1.0.x (2026-08-28)

- Fixed the authentication response parsing that prevented the original
  project from ever completing a live API call, plus list endpoints
  (ordersBulk), restaurant scoping headers, the labor report, and type errors.
