import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readCloudCosts } from "./CloudCostSummary.js";
it("reconciles rounded yen totals and discounts without converting currencies",()=>{
 const d=JSON.parse(readFileSync('apps/web/public/cloud-costs.json','utf8'));
 expect(readCloudCosts(d)?.net).toBe(5228);
 d.services[0].net++;expect(readCloudCosts(d)).toBeNull();
});
it("does not treat absent or foreign-currency data as zero yen",()=>{
 expect(readCloudCosts(null)).toBeNull();expect(readCloudCosts({currency:'USD'})).toBeNull();
});
