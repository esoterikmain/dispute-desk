// Agent eval: run every hand-labelled scenario through the Claude agent and the rules
// baseline, and compare each recommendation with the human answer.
//
//   npm run eval            (needs ANTHROPIC_API_KEY; spends a few cents per run)

process.env.DISPUTE_DESK_DB = "memory";
delete process.env.PAYPAL_CLIENT_ID;

import { gatherCase } from "@/lib/agent/casefile";
import { MODEL, claudeVerdict, hasClaude } from "@/lib/agent/claude";
import { rulesVerdict } from "@/lib/agent/rules";
import { getDispute, saveSettings } from "@/lib/repo";
import { SCENARIOS } from "@/lib/scenarios";
import { simulateDisputeForEval } from "@/lib/seed";
import { DEFAULT_SETTINGS } from "@/lib/types";

async function main() {
  await saveSettings(DEFAULT_SETTINGS);
  const useClaude = hasClaude();
  if (!useClaude) console.log("No ANTHROPIC_API_KEY set: scoring the rules baseline only.\n");

  let rulesRight = 0;
  let claudeRight = 0;
  const rows: Record<string, string | number>[] = [];

  for (const scenario of SCENARIOS) {
    const id = await simulateDisputeForEval(scenario.key);
    const dispute = (await getDispute(id))!;
    const rules = rulesVerdict(await gatherCase(dispute));
    if (rules.recommendation === scenario.expected) rulesRight++;

    const row: Record<string, string | number> = {
      scenario: scenario.key,
      expected: scenario.expected,
      rules: `${rules.recommendation} ${rules.win_probability}%`,
    };
    if (useClaude) {
      try {
        const verdict = await claudeVerdict(dispute);
        if (verdict.recommendation === scenario.expected) claudeRight++;
        row.claude = `${verdict.recommendation} ${verdict.win_probability}%`;
        row.ok = verdict.recommendation === scenario.expected ? "yes" : "NO";
      } catch (err) {
        row.claude = `error: ${err instanceof Error ? err.message : err}`;
        row.ok = "NO";
      }
    }
    rows.push(row);
  }

  console.table(rows);
  console.log(`Rules baseline: ${rulesRight}/${SCENARIOS.length} correct`);
  if (useClaude) console.log(`Claude (${MODEL}): ${claudeRight}/${SCENARIOS.length} correct`);
  process.exit(useClaude && claudeRight < SCENARIOS.length ? 1 : 0);
}

main();
