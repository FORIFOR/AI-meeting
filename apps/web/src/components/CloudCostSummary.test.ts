import { expect, it } from "vitest";
import { readCloudCosts } from "./CloudCostSummary.js";
import { cloudCostsFixture } from "../billing/testFixtures.js";
it("reconciles rounded yen totals and discounts without converting currencies",()=>{
 const d=cloudCostsFixture();
 expect(readCloudCosts(d)?.net).toBe(4750);
 d.services[0]!.net++;expect(readCloudCosts(d)).toBeNull();
});
it("does not treat absent or foreign-currency data as zero yen",()=>{
 expect(readCloudCosts(null)).toBeNull();expect(readCloudCosts({currency:'USD'})).toBeNull();
});
