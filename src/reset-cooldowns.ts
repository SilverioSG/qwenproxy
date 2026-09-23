import { clearAllAccountCooldowns } from "./core/account-manager.ts";
import { loadAccounts } from "./core/accounts.ts";
import { clearPersonalizationDbCache } from "./services/qwen.ts";

function main() {
  const accounts = loadAccounts();
  console.log(`🔍 Checking cooldowns for ${accounts.length} configured account(s)...`);
  const cleared = clearAllAccountCooldowns();
  const clearedPersonalization = clearPersonalizationDbCache();
  console.log(
    `✅ Cooldowns reset successfully: ${cleared} account(s) cleared. Personalization cache cleared: ${clearedPersonalization} account(s).`,
  );
}

main();
