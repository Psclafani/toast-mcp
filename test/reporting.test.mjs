// Issue #1: check-level discounts were subtracted twice in toast_get_sales_summary.
// Run: npm test (builds first, then node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerReportingTools } from '../dist/tools/reporting.js';

const disc = (guid, discountAmount, name = 'Disc') => ({
  guid, discountGuid: `cfg-${name}`, name, amount: discountAmount, discountAmount,
});

// Toast's check.amount is already net of every discount on the check.
// Two checks:
//  - check 1: $100 of items, $20 check-level discount            -> amount 80
//  - check 2: $50 of items, $5 item-level comp on one selection   -> amount 45
// Web "Net Sales Summary" would show gross 150, discounts 25, net 125.
const orders = [
  {
    guid: 'o1', voided: false, numberOfGuests: 2,
    checks: [
      {
        guid: 'c1', amount: 80, taxAmount: 6.6, totalAmount: 86.6,
        appliedDiscounts: [disc('ad-1', 20, '20 off')],
        selections: [
          { guid: 's1', voided: false, preDiscountPrice: 60, price: 48 },
          { guid: 's2', voided: false, preDiscountPrice: 40, price: 32 },
        ],
        payments: [{ tipAmount: 15 }],
      },
      {
        guid: 'c2', amount: 45, taxAmount: 3.71, totalAmount: 48.71,
        appliedDiscounts: [],
        selections: [
          { guid: 's3', voided: false, preDiscountPrice: 50, price: 45,
            appliedDiscounts: [disc('ad-2', 5, 'Loyalty')] },
          // voided selection carrying a discount must be ignored
          { guid: 's4', voided: true, preDiscountPrice: 10, price: 0,
            appliedDiscounts: [disc('ad-void', 10, 'Void comp')] },
        ],
        payments: [],
      },
    ],
  },
  // voided order: excluded from sales, counted in voidAmount
  { guid: 'o2', voided: true, numberOfGuests: 1, checks: [{ guid: 'c3', amount: 30, totalAmount: 32.5, appliedDiscounts: [disc('ad-3', 5)] }] },
];

function fakeClient(data) {
  return {
    getRestaurantGuid: () => 'rest-1',
    async getAllPages() { return data; },
    async get() { throw new Error('not expected'); },
  };
}
const toolsFor = (client) => Object.fromEntries(registerReportingTools(client).map(t => [t.name, t]));
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} != ${b}`);

test('sales summary counts check-level discounts once', async () => {
  const tools = toolsFor(fakeClient(orders));
  const out = await tools.toast_get_sales_summary.handler({ businessDate: 20260911 });
  close(out.grossSales, 150);
  close(out.discountAmount, 25);
  close(out.netSales, 125);            // was 105 before the fix (20 subtracted twice)
  close(out.netSales, 80 + 45);        // net == sum of check.amount
  close(out.totalSales, 86.6 + 48.71);
  close(out.tipAmount, 15);
  close(out.voidAmount, 32.5);
  assert.equal(out.checkCount, 2);
  assert.equal(out.guestCount, 2);
});

test('a discount surfaced at both check and selection level is counted once', async () => {
  const shared = disc('ad-shared', 10, 'Manager comp');
  const data = [{
    guid: 'o1', voided: false, numberOfGuests: 1,
    checks: [{
      guid: 'c1', amount: 90, taxAmount: 0, totalAmount: 90,
      appliedDiscounts: [shared],
      selections: [{ guid: 's1', voided: false, preDiscountPrice: 100, price: 90, appliedDiscounts: [shared] }],
      payments: [],
    }],
  }];
  const tools = toolsFor(fakeClient(data));
  const summary = await tools.toast_get_sales_summary.handler({ businessDate: 20260911 });
  close(summary.grossSales, 100);
  close(summary.discountAmount, 10);
  close(summary.netSales, 90);
  const report = await tools.toast_get_discount_report.handler({ businessDate: 20260911 });
  const total = report.discounts.reduce((s, d) => s + d.amount, 0);
  close(total, 10);
  assert.equal(report.discounts[0].count, 1);
});
