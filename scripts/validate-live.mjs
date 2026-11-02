#!/usr/bin/env node
// Live validation gauntlet for toast-mcp.
// Read-only. Requires TOAST_* env vars (same as the server) plus:
//   VALIDATE_RESTAURANT  - restaurantGuid or location name (default: server default)
//   VALIDATE_DATE        - businessDate yyyyMMdd (default: yesterday, server tz naive)
// Usage: node scripts/validate-live.mjs
import { spawn } from 'node:child_process';

const DATE = Number(process.env.VALIDATE_DATE || (() => {
  const d = new Date(Date.now() - 36 * 3600 * 1000); // ~yesterday, avoids midnight edges
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})());
const REST = process.env.VALIDATE_RESTAURANT; // optional

const child = spawn('node', [new URL('../dist/main.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
  env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = ''; const pending = new Map(); let nextId = 0;
child.stdout.on('data', d => {
  buf += d;
  let i; while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
child.stderr.on('data', () => {});
const rpc = (method, params, ms = 90000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), ms);
  const id = ++nextId; pending.set(id, m => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const callOnce = async (name, args = {}) => {
  if (REST && !('restaurantGuid' in args)) args.restaurantGuid = REST;
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) return { error: r.error.message };
  const text = r.result?.content?.[0]?.text;
  try { return { data: JSON.parse(text) }; } catch { return { data: text }; }
};
// Invariant fetches retry once on transient failure (rate limits, timeouts).
const call = async (name, args = {}) => {
  const first = await callOnce(name, { ...args });
  if (first.data !== undefined && first.data !== null) return first;
  await new Promise(r => setTimeout(r, 2500));
  return callOnce(name, { ...args });
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};
const close = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// Sample values per advertised JSON type, used to exercise every read tool's schema.
const sample = (prop, key) => {
  if (key === 'restaurantGuid') return undefined; // injected by call()
  if (key === 'businessDate') return prop.type === 'number' ? DATE : String(DATE);
  if (/date/i.test(key)) return '2026-08-24T05:00:00.000Z';
  if (prop.type === 'number') return 3;
  if (prop.type === 'boolean') return true;
  if (prop.enum) return prop.enum[0];
  if (/guid/i.test(key)) return '00000000-0000-0000-0000-000000000000';
  if (/query|search/i.test(key)) return 'test';
  return 'test';
};

const main = async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'validate-live', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  console.log(`\n=== toast-mcp live gauntlet: ${tools.length} tools, businessDate ${DATE} ===\n`);

  // ---- Layer 1: schema conformance sweep (read tools only) --------------
  console.log('--- Schema sweep: every read tool called with schema-conformant args ---');
  const skip = /create|update|void|refund|apply|add_|set_|bulk_|disable/;
  let schemaFails = 0;
  const slowTools = [];
  for (const t of tools) {
    if (skip.test(t.name)) continue;
    const args = {};
    for (const [k, prop] of Object.entries(t.inputSchema?.properties || {})) {
      if (prop.optional && !(t.inputSchema.required || []).includes(k)) {
        // still exercise optional numerics: they were the historical bug class
        if (prop.type !== 'number') continue;
      }
      const v = sample(prop, k);
      if (v !== undefined) args[k] = v;
    }
    let r;
    try {
      if (REST && !('restaurantGuid' in args)) args.restaurantGuid = REST;
      const resp = await rpc('tools/call', { name: t.name, arguments: args }, 20000);
      r = resp.error ? { error: resp.error.message } : { data: resp.result?.content?.[0]?.text };
    } catch (e) {
      slowTools.push(t.name);
      check(`bounded-runtime ${t.name}`, false, 'exceeded 20s - likely unbounded data scan; needs a server-side cap');
      continue;
    }
    const invalidType = r.error && /Invalid arguments/.test(r.error) && /Expected .* received/.test(r.error);
    if (invalidType) { schemaFails++; check(`schema ${t.name}`, false, r.error.slice(0, 90)); }
  }
  check('schema sweep', schemaFails === 0, schemaFails ? `${schemaFails} tools reject their own advertised schema` : 'all advertised schemas accepted');
  check('runtime sweep', slowTools.length === 0, slowTools.length ? `${slowTools.length} tools exceeded 20s: ${slowTools.join(', ')}` : 'all tools bounded');

  // ---- Layer 2: arithmetic invariants -----------------------------------
  console.log('\n--- Arithmetic invariants ---');
  await new Promise(r => setTimeout(r, 3000)); // let any rate-limit window clear after the sweep
  const sumResp = await call('toast_get_sales_summary', { businessDate: DATE });
  const sum = sumResp.data; const sumErr = sumResp.error;
  const hourly = (await call('toast_get_hourly_sales', { businessDate: DATE })).data;
  const items = (await call('toast_get_item_sales_report', { businessDate: DATE })).data;
  const disc = (await call('toast_get_discount_report', { businessDate: DATE })).data;
  const labor = (await call('toast_get_labor_report', { businessDate: DATE })).data;

  if (sum?.netSales === undefined) { check('sales summary fetch', false, JSON.stringify(sum ?? sumErr ?? null).slice(0, 80)); }
  else {
    check('sales summary fetch', true, `net $${sum.netSales.toFixed(2)}, ${sum.checkCount} checks`);
    const hourlyTotal = (hourly?.hourlyBreakdown || []).reduce((s, h) => s + h.sales, 0);
    check('hourly sums to day total', close(hourlyTotal, sum.totalSales, 0.05), `hourly $${hourlyTotal.toFixed(2)} vs total $${sum.totalSales.toFixed(2)}`);
    check('gross - discounts = net', close(sum.grossSales - sum.discountAmount, sum.netSales, 0.05), `${sum.grossSales.toFixed(2)} - ${sum.discountAmount.toFixed(2)} vs ${sum.netSales.toFixed(2)}`);
    if (items?.items) {
      check('item report has >1 bucket on a real day', items.totalItems > 1 || sum.checkCount <= 1, `${items.totalItems} items`);
      check('item gross >= net on every line', items.items.every(i => i.grossSales >= i.netSales - 0.005));
      check('item quantities are positive integers', items.items.every(i => i.quantity > 0));
      check('item net total <= day gross', items.totalSales <= sum.grossSales + 0.05, `items $${items.totalSales.toFixed(2)} vs gross $${sum.grossSales.toFixed(2)}`);
    } else check('item report fetch', false, JSON.stringify(items ?? null).slice(0, 80));
    if (disc?.discounts) {
      check('no "undefined" discount keys', disc.discounts.every(d => d.discountGuid && d.discountGuid !== 'undefined'));
      check('discount total matches summary', close(disc.totalDiscountAmount, sum.discountAmount, 0.05), `report $${(disc.totalDiscountAmount || 0).toFixed(2)} vs summary $${sum.discountAmount.toFixed(2)}`);
    } else check('discount report fetch', false, JSON.stringify(disc ?? null).slice(0, 80));
    if (labor?.totalHours !== undefined) {
      check('labor hours sane', labor.totalHours >= 0 && labor.regularHours + labor.overtimeHours <= labor.totalHours + 0.05, `${labor.totalHours}h total`);
    } else check('labor report fetch', false, JSON.stringify(labor ?? null).slice(0, 80));
  }

  const fails = results.filter(r => !r.ok);
  console.log(`\n=== ${results.length - fails.length}/${results.length} checks passed${fails.length ? ' - ' + fails.length + ' FAILURES' : ''} ===`);
  child.kill();
  process.exit(fails.length ? 1 : 0);
};
main().catch(e => { console.log('GAUNTLET ERROR:', e.message); child.kill(); process.exit(1); });
