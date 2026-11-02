// Net sales per Toast's "Calculating net sales using the orders API" guide:
// skip voided/deleted orders and checks (and excessFood orders); from
// check.amount subtract deferred (gift card) selections, house account
// payments, fundraising service charges and refunds.
// Run: npm test (builds first, then node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerReportingTools } from '../dist/tools/reporting.js';

const disc = (guid, discountAmount, name = 'Disc', extra = {}) => ({
  guid, discountGuid: `cfg-${name}`, name, amount: discountAmount, discountAmount, ...extra,
});

function fakeClient(data) {
  return {
    getRestaurantGuid: () => 'rest-1',
    async getAllPages() { return data; },
    async get() { throw new Error('not expected'); },
  };
}
const toolsFor = (data) => Object.fromEntries(registerReportingTools(fakeClient(data)).map(t => [t.name, t]));
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} != ${b}`);
const run = async (data) => {
  const tools = toolsFor(data);
  const summary = await tools.toast_get_sales_summary.handler({ businessDate: 20261031 });
  const discounts = await tools.toast_get_discount_report.handler({ businessDate: 20261031 });
  const items = await tools.toast_get_item_sales_report.handler({ businessDate: 20261031 });
  return { summary, discounts, items };
};

// A normal $40 dinner check, 2 guests, $4 item comp. amount = 36.
const dinner = (guid = 'o-live', checkGuid = 'c-live') => ({
  guid, voided: false, deleted: false, numberOfGuests: 2,
  checks: [{
    guid: checkGuid, voided: false, deleted: false, amount: 36, taxAmount: 3.78, totalAmount: 39.78,
    appliedDiscounts: [],
    selections: [
      { guid: `${checkGuid}-s1`, voided: false, deferred: false, displayName: 'Shrimp & Grits', quantity: 1, preDiscountPrice: 25, price: 25 },
      { guid: `${checkGuid}-s2`, voided: false, deferred: false, displayName: 'Gumbo', quantity: 1, preDiscountPrice: 15, price: 11,
        appliedDiscounts: [disc(`${checkGuid}-d1`, 4, 'Guest Recovery - Item')] },
    ],
    payments: [{ tipAmount: 7 }],
  }],
});

test('gift card sales are left out of net and gross and reported separately', async () => {
  const order = dinner();
  // $50 gift card sold on the same check: check.amount includes it.
  order.checks[0].amount += 50;
  order.checks[0].totalAmount += 50;
  order.checks[0].selections.push({ guid: 'gc', voided: false, deferred: true, displayName: 'Gift Card', quantity: 1, preDiscountPrice: 50, price: 50 });
  const { summary } = await run([order]);
  close(summary.netSales, 36);
  close(summary.grossSales, 40);
  close(summary.discountAmount, 4);
  close(summary.giftCardSales, 50);
  close(summary.totalSales, 89.78); // like Toast Web "Total Amount", gift card included
});

test('a deleted order (check combined into another order) is not counted twice', async () => {
  const original = { ...dinner('o-old', 'c-old'), deleted: true };
  const combined = dinner('o-new', 'c-new');
  const { summary, discounts, items } = await run([original, combined]);
  close(summary.netSales, 36);
  assert.equal(summary.guestCount, 2);
  assert.equal(summary.orderCount, 1);
  assert.equal(summary.checkCount, 1);
  assert.equal(summary.excluded.deletedOrders, 1);
  close(discounts.totalDiscountAmount, 4);
  assert.equal(items.totalQuantity, 2);
});

test('deleted and voided checks inside a live order are skipped, with their discounts', async () => {
  const order = dinner();
  order.checks.push(
    { guid: 'c-del', deleted: true, voided: false, amount: 46, taxAmount: 4.82, totalAmount: 50.82,
      appliedDiscounts: [disc('d-del', 0.5, 'Birthday Dessert')], selections: [], payments: [] },
    { guid: 'c-void', deleted: false, voided: true, amount: 0, taxAmount: 0, totalAmount: 0,
      appliedDiscounts: [disc('d-void', 12, 'Employee 50% Discount - Item')], selections: [], payments: [] },
  );
  const { summary, discounts } = await run([order]);
  close(summary.netSales, 36);
  close(summary.discountAmount, 4);
  close(summary.grossSales, 40);
  assert.equal(summary.checkCount, 1);
  assert.equal(summary.excluded.deletedChecks, 1);
  assert.equal(summary.excluded.voidedChecks, 1);
  close(discounts.totalDiscountAmount, 4);
});

test('a loyalty reward removed from the check (processingState VOID) is not counted', async () => {
  const order = dinner();
  const loyalty = { vendor: 'TOAST', referenceId: 'r1' };
  order.checks[0].appliedDiscounts.push(disc('d-removed', 10, 'Cash Reward', { processingState: 'VOID', loyaltyDetails: loyalty }));
  order.checks[0].selections[0].appliedDiscounts = [disc('d-pending', 3, 'Birthday Reward', { processingState: 'PENDING_VOID', loyaltyDetails: loyalty })];
  const { summary, discounts } = await run([order]);
  close(summary.discountAmount, 4);
  close(summary.grossSales, 40);
  close(summary.netSales, 36);
  close(discounts.totalDiscountAmount, 4);
  assert.equal(discounts.discounts.length, 1);
});

test('ordinary discounts (processingState null) and applied loyalty rewards are counted', async () => {
  const order = dinner();
  const check = order.checks[0];
  check.amount -= 7.26 + 5;
  check.appliedDiscounts.push(
    disc('d-reward', 7.26, 'Cash Reward', { processingState: 'APPLIED', loyaltyDetails: { vendor: 'TOAST' } }),
    disc('d-mil', 5, 'Military/Uniformed Officer Discount', { processingState: null }),
  );
  const { summary, discounts } = await run([order]);
  close(summary.discountAmount, 4 + 7.26 + 5);
  close(summary.grossSales, 40);
  close(summary.netSales, 36 - 12.26);
  close(discounts.totalDiscountAmount, 16.26);
});

test('a refund counts on the day it was made, not the day of the order', async () => {
  const order = dinner();
  order.checks[0].payments.push(
    { tipAmount: 0, refund: { refundAmount: 6, refundBusinessDate: 20261031 } },
    { tipAmount: 0, refund: { refundAmount: 9, refundBusinessDate: 20261102 } },
  );
  const { summary } = await run([order]);
  close(summary.refundAmount, 6);
  close(summary.netSales, 30);
});

test('gift card reloads flagged only by selectionType are still left out', async () => {
  const order = dinner();
  order.checks[0].amount += 25;
  order.checks[0].selections.push({ guid: 'reload', voided: false, selectionType: 'TOAST_CARD_RELOAD', displayName: 'Gift Card Reload', quantity: 1, price: 25 });
  const { summary } = await run([order]);
  close(summary.netSales, 36);
  close(summary.giftCardSales, 25);
});

test('house account payments, fundraising charges and refunds are not net sales', async () => {
  const order = dinner();
  const check = order.checks[0];
  check.amount += 100 + 5; // $100 house-account balance payment + $5 round-up donation
  check.selections.push({ guid: 'ha', voided: false, deferred: false, selectionType: 'HOUSE_ACCOUNT_PAY_BALANCE', displayName: 'Pay balance', quantity: 1, price: 100 });
  check.appliedServiceCharges = [
    { guid: 'sc1', name: 'Round up', chargeAmount: 5, gratuity: false, serviceChargeCategory: 'FUNDRAISING_CAMPAIGN' },
    { guid: 'sc2', name: 'Large Party', chargeAmount: 8, gratuity: true, serviceChargeCategory: 'SERVICE_CHARGE' },
  ];
  check.payments.push({ tipAmount: 0, refund: { refundAmount: 6, tipRefundAmount: 1 } });
  const { summary } = await run([order]);
  close(summary.houseAccountPayments, 100);
  close(summary.fundraisingCharges, 5);
  close(summary.refundAmount, 6);
  close(summary.grossSales, 40);       // gross - discounts - refunds = net (Toast Web)
  close(summary.netSales, 40 - 4 - 6);
});

test('voided and excess-food orders are skipped; voided totals still reported', async () => {
  const voided = { ...dinner('o-void', 'c-v'), voided: true };
  const waste = { ...dinner('o-waste', 'c-w'), excessFood: true };
  const { summary, discounts } = await run([voided, waste, dinner()]);
  close(summary.netSales, 36);
  assert.equal(summary.guestCount, 2);
  close(summary.voidAmount, 39.78);
  assert.equal(summary.excluded.voidedOrders, 1);
  assert.equal(summary.excluded.excessFoodOrders, 1);
  close(discounts.totalDiscountAmount, 4);
});
