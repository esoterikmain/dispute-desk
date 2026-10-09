import { beforeAll, describe, expect, it } from "vitest";

process.env.DISPUTE_DESK_DB = "memory";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PAYPAL_CLIENT_ID;

import { evidenceScore, gatherCase } from "@/lib/agent/casefile";
import { rulesVerdict } from "@/lib/agent/rules";
import { act, analyzeDispute, forceOutcome } from "@/lib/desk";
import { keywordQuery } from "@/lib/nlfilter";
import { evidencePdf } from "@/lib/pdf";
import { getDispute, getOrder, insertDispute, listAudit, listDisputes, saveSettings } from "@/lib/repo";
import { SCENARIOS } from "@/lib/scenarios";
import { resetDemo, simulateDispute } from "@/lib/seed";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { takeAllowance, usageToday } from "@/lib/usage";

async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const row = await getDispute(id);
    if (row?.agent_status === "done") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`analysis of ${id} never finished`);
}

describe("rules engine", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.key} -> ${scenario.expected}`, async () => {
      const row = await settled(await simulateDispute(scenario.key));
      const verdict = rulesVerdict(await gatherCase(row));
      expect(verdict.recommendation).toBe(scenario.expected);
      if (scenario.expected === "FIGHT") expect(verdict.response_letter).toContain(row.id);
    });
  }
});

describe("dispute lifecycle on the simulator", () => {
  let id: string;
  beforeAll(async () => {
    id = await simulateDispute("inr-delivered-signed");
    await settled(id);
  });

  it("stores the verdict and an evidence score", async () => {
    const row = (await getDispute(id))!;
    expect(row.engine).toBe("rules");
    expect(row.verdict?.win_probability).toBeGreaterThanOrEqual(85);
    expect(evidenceScore(await gatherCase(row))).toBe(100);
  });

  it("builds a PDF evidence packet", async () => {
    const row = (await getDispute(id))!;
    const pdf = await evidencePdf(row, await getOrder(row.order_id!), row.verdict!.response_letter);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("submits evidence, then records a seller-favour ruling as WON", async () => {
    await act(id, { action: "FIGHT", actor: "merchant" });
    let row = (await getDispute(id))!;
    expect(row.status).toBe("UNDER_REVIEW");
    expect(row.decision).toBe("FIGHT");

    await forceOutcome(id, "SELLER_FAVOR");
    row = (await getDispute(id))!;
    expect(row.outcome).toBe("WON");
    expect((await listAudit(id)).map((a) => a.action)).toEqual([
      "dispute_received",
      "analysed",
      "submitted_fight",
      "sandbox_adjudicated",
      "resolved",
    ]);
  });

  it("refuses to action a dispute twice", async () => {
    await expect(act(id, { action: "REFUND", actor: "merchant" })).rejects.toThrow(/already/);
  });

  it("treats an accepted partial offer as SETTLED", async () => {
    const offerId = await simulateDispute("snad-minor-defect");
    await settled(offerId);
    await act(offerId, { action: "OFFER", actor: "merchant", offerAmount: 40 });
    await forceOutcome(offerId, "BUYER_FAVOR");
    expect((await getDispute(offerId))!.outcome).toBe("SETTLED");
  });

  it("rejects an offer that is not below the disputed amount", async () => {
    const offerId = await simulateDispute("snad-minor-defect");
    await settled(offerId);
    await expect(act(offerId, { action: "OFFER", actor: "merchant", offerAmount: 240 })).rejects.toThrow(/between/);
  });
});

describe("autopilot", () => {
  it("auto-refunds a small unwinnable claim and leaves larger ones for the merchant", async () => {
    await saveSettings({ autopilot: true, auto_refund_under: 25, auto_fight_above: 101 });
    const small = await simulateDispute("inr-no-tracking"); // $18.50, REFUND
    const large = await simulateDispute("unauth-reshipped-new-account"); // $449, REFUND
    await settled(small);
    await settled(large);
    await analyzeDispute(large); // make sure autopilot had its chance
    expect((await getDispute(small))!.decided_by).toBe("autopilot");
    expect((await getDispute(small))!.outcome).toBe("REFUNDED");
    expect((await getDispute(large))!.decision).toBeNull();
    await saveSettings(DEFAULT_SETTINGS);
  });
});

describe("sample cases next to real PayPal cases", () => {
  it("resetting the samples keeps cases that came from PayPal", async () => {
    const sampleId = await simulateDispute("inr-no-tracking");
    const sample = await settled(sampleId);
    expect(sample.source).toBe("simulator");
    await insertDispute({ ...sample, id: "PP-R-REAL-1", source: "paypal" });

    await resetDemo();

    expect(await getDispute(sampleId)).toBeNull();
    expect((await getDispute("PP-R-REAL-1"))?.source).toBe("paypal");
    expect((await listDisputes()).filter((d) => d.source === "simulator").length).toBeGreaterThan(10);
  });
});

describe("daily AI allowance", () => {
  it("grants calls up to the ceiling, then refuses", async () => {
    process.env.AI_DAILY_FILTERS = "2";
    expect(await takeAllowance("filter")).toBe(true);
    expect(await takeAllowance("filter")).toBe(true);
    expect(await takeAllowance("filter")).toBe(false);
    expect(await usageToday("filter")).toEqual({ used: 2, limit: 2 });
  });

  it("treats zero as unlimited", async () => {
    process.env.AI_DAILY_FILTERS = "0";
    expect(await takeAllowance("filter")).toBe(true);
    delete process.env.AI_DAILY_FILTERS;
  });
});

describe("keyword grid query", () => {
  it("parses reason, amount and deadline", () => {
    const q = keywordQuery("unauthorized claims over $100 due this week");
    expect(q.filters).toEqual([
      { field: "reason", op: "equals", value: "Unauthorized" },
      { field: "amount", op: "greaterThan", value: "100" },
      { field: "due_in_hours", op: "lessThan", value: "168" },
    ]);
  });
});
