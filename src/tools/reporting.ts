import { z } from 'zod';
import { ToastClient } from '../clients/toast.js';
import type { Order, MenuItemSales } from '../types/index.js';

/**
 * Reporting & Analytics Tools
 */

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
        let grossSales = 0;
        let netSales = 0;
        let taxAmount = 0;
        let tipAmount = 0;
        let discountAmount = 0;
        let voidAmount = 0;
        let refundAmount = 0;
        let guestCount = 0;
        let checkCount = 0;

        orders.forEach(order => {
          if (order.voided) {
            voidAmount += order.checks.reduce((sum, check) => sum + (check.totalAmount || 0), 0);
            return;
          }

          guestCount += order.numberOfGuests || 0;
          checkCount += order.checks.length;

          order.checks.forEach(check => {
            // check.amount is Toast's net: already reduced by BOTH check-level
            // and item-level discounts. Start there, then add every discount
            // back into gross so gross - discounts = net (issue #1: check-level
            // discounts used to be subtracted a second time).
            grossSales += check.amount || 0;
            taxAmount += check.taxAmount || 0;
            totalSales += check.totalAmount || 0;

            check.payments?.forEach(payment => {
              tipAmount += payment.tipAmount || 0;
              if (payment.refund) {
                refundAmount += payment.refund.refundAmount || 0;
              }
            });

            // The same applied discount can surface on the check and again on
            // the selections it was prorated across; count each guid once.
            const seenDiscounts = new Set<string>();
            const countDiscount = (d: any) => {
              if (!d) return;
              if (d.guid) {
                if (seenDiscounts.has(d.guid)) return;
                seenDiscounts.add(d.guid);
              }
              const amt = d.discountAmount || 0;
              discountAmount += amt;
              grossSales += amt;
            };

            check.appliedDiscounts?.forEach(countDiscount);
            check.selections?.forEach(selection => {
              if ((selection as any).voided) return;
              (selection as any).appliedDiscounts?.forEach(countDiscount);
            });
          });
        });

        netSales = grossSales - discountAmount;

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
          guestCount,
          checkCount,
          averageCheck: checkCount > 0 ? netSales / checkCount : 0,
          averageGuestSpend: guestCount > 0 ? netSales / guestCount : 0,
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
          if (order.voided) return;

          const hour = new Date(order.openedDate).getHours();
          if (!hourlyData[hour]) {
            hourlyData[hour] = { sales: 0, orders: 0, guests: 0 };
          }

          hourlyData[hour].orders++;
          hourlyData[hour].guests += order.numberOfGuests || 0;

          order.checks.forEach(check => {
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
          if (order.voided) return;

          order.checks.forEach(check => {
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

        // Same applied discount can appear on the check and on the selections
        // it was prorated across; count each guid once (matches sales summary).
        const seenDiscounts = new Set<string>();
        const record = (discount: any) => {
          if (!discount) return;
          if (discount.guid) {
            if (seenDiscounts.has(discount.guid)) return;
            seenDiscounts.add(discount.guid);
          }
          // Applied discounts reference the discount config as an object;
          // fall back to name so nothing lands under the literal "undefined".
          const key: string = discount?.discount?.guid || discount?.discountGuid || discount?.name || 'unknown';
          if (!discounts[key]) {
            discounts[key] = { name: discount?.name || 'Unknown discount', amount: 0, count: 0 };
          }
          discounts[key].amount += discount?.discountAmount || 0;
          discounts[key].count++;
        };

        orders.forEach(order => {
          order.checks.forEach(check => {
            check.appliedDiscounts?.forEach(record);
            // Item-level comps (loyalty rewards, single-item discounts) live on
            // the selection, not the check. Count both.
            check.selections?.forEach(selection => {
              if (!(selection as any).voided) {
                (selection as any).appliedDiscounts?.forEach(record);
              }
            });
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
