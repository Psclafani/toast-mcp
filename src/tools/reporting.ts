import { z } from 'zod';
import { ToastClient } from '../clients/toast.js';
import type { Order, Check, MenuItemSales } from '../types/index.js';

/**
 * Reporting & Analytics Tools
 */

// Net-sales rules follow Toast's "Calculating net sales using the orders API"
// guide (doc.toasttab.com/doc/devguide/apiOrdersNetSalesCalculation.html):
//  - skip orders and checks where voided or deleted is true (a deleted order is
//    e.g. one whose check was combined into another order, so counting it
//    would double the sale), and orders where excessFood is true;
//  - start from check.amount, then subtract selections where deferred is true
//    (gift card sales) or selectionType is HOUSE_ACCOUNT_PAY_BALANCE, service
//    charges whose serviceChargeCategory is FUNDRAISING_CAMPAIGN, and refunds.

/** True when an order should count toward sales (not voided/deleted/excess food). */
export function isCountableOrder(order: Order): boolean {
  return !order.voided && !order.deleted && !(order as any).excessFood;
}

/** True when a check should count toward sales (not voided/deleted). */
export function isCountableCheck(check: Check): boolean {
  return !check.voided && !check.deleted;
}

/** Gift card sales and reloads: revenue is deferred until the card is used. */
function isGiftCardSelection(selection: any): boolean {
  return selection.deferred === true
    || selection.selectionType === 'TOAST_CARD_SELL'
    || selection.selectionType === 'TOAST_CARD_RELOAD';
}

/** Selections that are not revenue for this business date (Toast guide, step 4). */
function isNonRevenueSelection(selection: any): boolean {
  return isGiftCardSelection(selection) || selection.selectionType === 'HOUSE_ACCOUNT_PAY_BALANCE';
}

/**
 * Loyalty-reward discounts that were removed from the check still come back
 * from the API with processingState VOID / PENDING_VOID (the field is null for
 * ordinary discounts).
 */
function isRemovedDiscount(discount: any): boolean {
  return discount?.processingState === 'VOID' || discount?.processingState === 'PENDING_VOID';
}

/**
 * Calls fn once per applied discount that counts toward sales: on countable
 * checks only, never on voided or non-revenue selections, never a removed
 * discount, and each applied-discount guid once per check (the same discount
 * can surface on the check and on the selections it was prorated across).
 */
function forEachCountedDiscount(check: Check, fn: (discount: any) => void) {
  const seen = new Set<string>();
  const visit = (d: any) => {
    if (!d || isRemovedDiscount(d)) return;
    if (d.guid) {
      if (seen.has(d.guid)) return;
      seen.add(d.guid);
    }
    fn(d);
  };
  check.appliedDiscounts?.forEach(visit);
  check.selections?.forEach(selection => {
    const sel = selection as any;
    if (sel.voided || isNonRevenueSelection(sel)) return;
    sel.appliedDiscounts?.forEach(visit);
  });
}

export function registerReportingTools(client: ToastClient) {
  return [
    {
      name: 'toast_get_sales_summary',
      description: 'Get comprehensive sales summary for a business date',
      inputSchema: z.object({
        businessDate: z.number().describe('Business date in YYYYMMDD format'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        let totalSales = 0;
        let salesBeforeDiscounts = 0; // check.amount less non-revenue items, before discounts are added back
        let taxAmount = 0;
        let tipAmount = 0;
        let discountAmount = 0;
        let voidAmount = 0;
        let refundAmount = 0;
        let giftCardSales = 0;
        let houseAccountPayments = 0;
        let fundraisingCharges = 0;
        let guestCount = 0;
        let orderCount = 0;
        let checkCount = 0;
        const excluded = { voidedOrders: 0, deletedOrders: 0, excessFoodOrders: 0, voidedChecks: 0, deletedChecks: 0 };

        orders.forEach(order => {
          if (order.deleted) { excluded.deletedOrders++; return; }
          if ((order as any).excessFood) { excluded.excessFoodOrders++; return; }
          if (order.voided) {
            excluded.voidedOrders++;
            voidAmount += order.checks.reduce((sum, check) => sum + (check.totalAmount || 0), 0);
            return;
          }

          const checks = order.checks.filter(check => {
            if (check.deleted) { excluded.deletedChecks++; return false; }
            if (check.voided) {
              excluded.voidedChecks++;
              voidAmount += check.totalAmount || 0;
              return false;
            }
            return true;
          });
          if (checks.length === 0) return;

          orderCount++;
          guestCount += order.numberOfGuests || 0;
          checkCount += checks.length;

          checks.forEach(check => {
            // check.amount is Toast's net: already reduced by BOTH check-level
            // and item-level discounts, and it includes non-gratuity service
            // charges. Discounts are added back below so gross - discounts = net
            // (issue #1: check-level discounts used to be subtracted twice).
            salesBeforeDiscounts += check.amount || 0;
            taxAmount += check.taxAmount || 0;
            totalSales += check.totalAmount || 0;

            check.selections?.forEach(selection => {
              const sel = selection as any;
              if (sel.voided || !isNonRevenueSelection(sel)) return;
              const price = sel.price || 0;
              salesBeforeDiscounts -= price;
              if (isGiftCardSelection(sel)) giftCardSales += price;
              else houseAccountPayments += price;
            });

            check.appliedServiceCharges?.forEach(charge => {
              if ((charge as any).serviceChargeCategory !== 'FUNDRAISING_CAMPAIGN') return;
              const amt = charge.chargeAmount || 0;
              salesBeforeDiscounts -= amt;
              fundraisingCharges += amt;
            });

            check.payments?.forEach(payment => {
              tipAmount += payment.tipAmount || 0;
              // Toast Web counts a refund on the day it was made. Refunds made
              // later on this day's orders belong to that later date; refunds
              // made today on earlier orders are not in this order list.
              const refund: any = payment.refund;
              if (refund && (refund.refundBusinessDate == null || refund.refundBusinessDate === args.businessDate)) {
                refundAmount += refund.refundAmount || 0;
              }
            });

            forEachCountedDiscount(check, d => {
              discountAmount += d.discountAmount || 0;
            });
          });
        });

        // Toast Web: Gross - Discounts - Refunds = Net Sales.
        const grossSales = salesBeforeDiscounts + discountAmount;
        const netSales = salesBeforeDiscounts - refundAmount;

        return {
          businessDate: args.businessDate,
          totalSales,
          grossSales,
          netSales,
          taxAmount,
          tipAmount,
          discountAmount,
          voidAmount,
          refundAmount,
          giftCardSales,
          houseAccountPayments,
          fundraisingCharges,
          guestCount,
          orderCount,
          checkCount,
          averageCheck: checkCount > 0 ? netSales / checkCount : 0,
          averageGuestSpend: guestCount > 0 ? netSales / guestCount : 0,
          excluded,
          notes: 'Net sales follow Toast\'s orders-API net-sales guide: voided/deleted orders and checks are skipped; gift card sales (giftCardSales), house account payments, fundraising charges and refunds are not net sales (refundAmount = refunds made on this business date against this date\'s orders; refunds made today on earlier orders are not included). totalSales is the sum of check totals (Toast Web "Total Amount").',
        };
      },
    },

    {
      name: 'toast_get_hourly_sales',
      description: 'Get sales broken down by hour for a business date',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const hourlyData: Record<number, { sales: number; orders: number; guests: number }> = {};

        orders.forEach(order => {
          if (!isCountableOrder(order)) return;
          const checks = order.checks.filter(isCountableCheck);
          if (checks.length === 0) return;

          const hour = new Date(order.openedDate).getHours();
          if (!hourlyData[hour]) {
            hourlyData[hour] = { sales: 0, orders: 0, guests: 0 };
          }

          hourlyData[hour].orders++;
          hourlyData[hour].guests += order.numberOfGuests || 0;

          checks.forEach(check => {
            hourlyData[hour].sales += check.totalAmount || 0;
          });
        });

        const hourlyArray = Array.from({ length: 24 }, (_, hour) => ({
          hour,
          ...( hourlyData[hour] || { sales: 0, orders: 0, guests: 0 }),
        }));

        return {
          businessDate: args.businessDate,
          hourlyBreakdown: hourlyArray,
        };
      },
    },

    {
      name: 'toast_get_item_sales_report',
      description: 'Get sales report for menu items',
      inputSchema: z.object({
        businessDate: z.number().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        limit: z.number().optional().describe('Return top N items'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate?: number; startDate?: string; endDate?: string; limit?: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
            startDate: args.startDate,
            endDate: args.endDate,
          }
        );

        const itemSales = new Map<string, MenuItemSales>();

        orders.forEach(order => {
          if (!isCountableOrder(order)) return;

          order.checks.forEach(check => {
            if (!isCountableCheck(check)) return;
            check.selections.forEach(selection => {
              if (selection.voided) return;

              // Group on the menu item reference guid (selections carry the item
              // as a reference object, not a flat itemGuid), falling back to the
              // display name so unmapped items still bucket by name.
              const sel = selection as any;
              const key: string = sel.item?.guid || selection.displayName || 'unknown';
              // preDiscountPrice is the true gross; price is already net of discounts.
              const gross: number = sel.preDiscountPrice ?? selection.price ?? 0;
              const net: number = selection.price ?? gross;

              const existing = itemSales.get(key);
              if (existing) {
                existing.quantity += selection.quantity;
                existing.grossSales += gross;
                existing.netSales += net;
              } else {
                itemSales.set(key, {
                  itemGuid: sel.item?.guid || '',
                  itemName: selection.displayName || 'Unknown item',
                  quantity: selection.quantity,
                  grossSales: gross,
                  netSales: net,
                });
              }
            });
          });
        });

        let items = Array.from(itemSales.values());
        items.sort((a, b) => b.netSales - a.netSales);

        if (args.limit) {
          items = items.slice(0, args.limit);
        }

        return {
          items,
          totalItems: items.length,
          totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
          totalSales: items.reduce((sum, item) => sum + item.netSales, 0),
        };
      },
    },

    {
      name: 'toast_get_payment_type_report',
      description: 'Get breakdown of sales by payment type',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const paymentTypes: Record<string, { amount: number; tipAmount: number; count: number }> = {};

        orders.forEach(order => {
          order.checks.forEach(check => {
            check.payments?.forEach(payment => {
              const type = payment.type || 'UNKNOWN';
              if (!paymentTypes[type]) {
                paymentTypes[type] = { amount: 0, tipAmount: 0, count: 0 };
              }
              paymentTypes[type].amount += payment.amount;
              paymentTypes[type].tipAmount += payment.tipAmount || 0;
              paymentTypes[type].count++;
            });
          });
        });

        return {
          businessDate: args.businessDate,
          paymentTypes,
        };
      },
    },

    {
      name: 'toast_get_discount_report',
      description: 'Get report on discounts applied',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const discounts: Record<string, { name: string; amount: number; count: number }> = {};

        const record = (discount: any) => {
          // Applied discounts reference the discount config as an object;
          // fall back to name so nothing lands under the literal "undefined".
          const key: string = discount?.discount?.guid || discount?.discountGuid || discount?.name || 'unknown';
          if (!discounts[key]) {
            discounts[key] = { name: discount?.name || 'Unknown discount', amount: 0, count: 0 };
          }
          discounts[key].amount += discount?.discountAmount || 0;
          discounts[key].count++;
        };

        // Same rules as toast_get_sales_summary so the totals agree: only
        // countable orders/checks, item-level comps included, removed
        // discounts and discounts on voided items skipped, each guid once.
        orders.forEach(order => {
          if (!isCountableOrder(order)) return;
          order.checks.forEach(check => {
            if (!isCountableCheck(check)) return;
            forEachCountedDiscount(check, record);
          });
        });

        const discountArray = Object.entries(discounts).map(([guid, data]) => ({
          discountGuid: guid,
          ...data,
        }));

        discountArray.sort((a, b) => b.amount - a.amount);

        return {
          businessDate: args.businessDate,
          discounts: discountArray,
          totalDiscountAmount: discountArray.reduce((sum, d) => sum + d.amount, 0),
        };
      },
    },

    {
      name: 'toast_get_void_report',
      description: 'Get report on voided orders and items',
      inputSchema: z.object({
        businessDate: z.number(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { businessDate: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        
        const orders = await client.getAllPages<Order>(
          `/orders/v2/ordersBulk`,
          {
            restaurantGuid: restGuid,
            businessDate: args.businessDate,
          }
        );

        const voidedOrders = orders.filter(o => o.voided);
        const voidedSelections: any[] = [];

        orders.forEach(order => {
          order.checks.forEach(check => {
            check.selections.forEach(selection => {
              if (selection.voided) {
                voidedSelections.push({
                  orderGuid: order.guid,
                  itemName: selection.displayName,
                  quantity: selection.quantity,
                  amount: selection.price,
                  voidDate: selection.voidDate,
                });
              }
            });
          });
        });

        const totalVoidedAmount =
          voidedOrders.reduce((sum, order) =>
            sum + order.checks.reduce((checkSum, check) => checkSum + (check.totalAmount || 0), 0),
          0) +
          voidedSelections.reduce((sum, sel) => sum + sel.amount, 0);

        return {
          businessDate: args.businessDate,
          voidedOrderCount: voidedOrders.length,
          voidedSelectionCount: voidedSelections.length,
          totalVoidedAmount,
          voidedOrders: voidedOrders.map(o => ({
            orderGuid: o.guid,
            voidDate: o.voidDate,
            amount: o.checks.reduce((sum, c) => sum + (c.totalAmount || 0), 0),
          })),
          voidedSelections,
        };
      },
    },
  ];
}
