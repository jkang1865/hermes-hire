#!/usr/bin/env node

// ──────────────────────────────────────────────────────────────────────
// hermes-hire — CLI wizard for spinning up new Hermes agent profiles
//               and registering them in Paperclip.
//               Generic — no business-specific hardcoding.
// ──────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

// ── Resolve the REAL system home directory ───────────────────────────
// Hermes may redirect HOME to a nested profile workspace (e.g.
// ~/.hermes/profiles/foo/home). Walk up to find the actual home that
// contains the .hermes config root.
function getRealHome() {
  const envHome = process.env.HOME || os.homedir();
  const candidate = path.join(envHome, ".hermes");
  if (fs.existsSync(candidate)) return envHome; // normal case

  // Walk up until we find a path where parent/.hermes/profiles exists
  let current = envHome;
  for (let i = 0; i < 10; i++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    const profilesDir = path.join(parent, ".hermes", "profiles");
    if (fs.existsSync(profilesDir)) return parent;
    current = parent;
  }
  return envHome;
}

const REAL_HOME = getRealHome();
const HERMES_DIR = path.join(REAL_HOME, ".hermes");
const PROFILES_DIR = path.join(HERMES_DIR, "profiles");

// ── Paperclip registration endpoint ──────────────────────────────────
// Verify this endpoint and companyId against your running Paperclip instance at http://localhost:3100
const PAPERCLIP_API = "http://localhost:3100/api/agents";
const PAPERCLIP_COMPANY_ID = 1;

// ── Parse CLI arguments ──────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {};
  const knownFlags = [
    "role",
    "title",
    "purpose",
    "toolsets",
    "budget",
    "telegram-token",
    "donor",
    "company-prefix",
    "help",
  ];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      return flags;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (knownFlags.includes(key)) {
        // Next arg is the value (unless it's a boolean flag)
        if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
          flags[key] = argv[++i];
        } else {
          flags[key] = true;
        }
      } else {
        console.warn(`Warning: unknown flag --${key}`);
      }
    }
  }

  return flags;
}

function showHelp() {
  console.log(`
hermes-hire — Automated Hermes Agent Profile Provisioner

Usage:
  Interactive mode:    node index.js
  Non-interactive:     node index.js --role cmo --title "Chief Marketing Officer" \\
                         --purpose "Handles ASO and social content" \\
                         --toolsets web,file,browser --budget 5 \\
                         --telegram-token "123456:ABC" \\
                         --donor shelfscout-coder --company-prefix shelfscout

Options:
  --role              Agent role slug (e.g. cmo, cro, cfo)
  --title             Full job title (e.g. "Chief Marketing Officer")
  --purpose           1-2 sentence purpose, becomes first line of SOUL.md
  --toolsets          Comma-separated toolsets (e.g. web,file,browser)
  --budget            Monthly budget in USD (default: 5)
  --telegram-token    Telegram bot token (leave unset to skip gateway setup)
  --donor             Existing profile to clone from
  --company-prefix    Company prefix (e.g. shelfscout, acme)
  --help, -h          Show this help message
`);
}

// ── Step 1: Discover donor profile ───────────────────────────────────
function discoverProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) {
    console.error(`Error: Profiles directory not found at ${PROFILES_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PROFILES_DIR, e.name, "config.yaml")))
    .map((e) => e.name)
    .sort();
}

function readDonorConfig(donor) {
  const configPath = path.join(PROFILES_DIR, donor, "config.yaml");
  const envPath = path.join(PROFILES_DIR, donor, ".env");

  const config = yaml.load(fs.readFileSync(configPath, "utf-8"));
  const model = config.model || "unknown";

  // Extract provider from config (providers object or infer from model string)
  let provider = "";
  if (config.providers && typeof config.providers === "object") {
    // Providers may be keyed by provider name
    const keys = Object.keys(config.providers);
    if (keys.length > 0) provider = keys[0];
  }
  // Infer from model slug (e.g. "qwen/qwen3.6-plus" → openrouter)
  if (!provider && typeof model === "string" && model.includes("/")) {
    provider = "openrouter";
  }

  // Read .env for OPENROUTER_API_KEY
  let openrouterKey = "";
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("OPENROUTER_API_KEY=")) {
        openrouterKey = trimmed.split("=").slice(1).join("=").replace(/['"]/g, "").trim();
      }
    }
  }

  return { model, provider, openrouterKey, config };
}

// ── Step 2: Interactive prompts ──────────────────────────────────────
async function askQuestions(profiles, args) {
  const rl = readline.createInterface({ input, output });

  const q = async (question, defaultVal) => {
    const suffix = defaultVal ? ` [default: ${defaultVal}]` : "";
    const answer = await rl.question(`${question}${suffix} `);
    return answer.trim() || defaultVal || "";
  };

  // Donor
  let donor = args["donor"] || "";
  if (!donor) {
    console.log("\nAvailable profiles:");
    profiles.forEach((p) => console.log(`  - ${p}`));
    while (!donor) {
      donor = await q("\nWhich existing profile to clone from?", "");
    }
  }

  // Company prefix
  let companyPrefix = args["company-prefix"] || "";
  if (!companyPrefix) {
    while (!companyPrefix) {
      companyPrefix = await q("Company prefix? (e.g. shelfscout, acme)", "");
    }
  }

  // Role
  let role = args["role"] || "";
  if (!role) {
    while (!role) {
      role = await q("Agent role slug? (e.g. cmo, cro, cfo)", "");
    }
  }

  // Title
  let title = args["title"] || "";
  if (!title) {
    while (!title) {
      title = await q("Job title? (e.g. Chief Marketing Officer)", "");
    }
  }

  // Purpose
  let purpose = args["purpose"] || "";
  if (!purpose) {
    while (!purpose) {
      purpose = await q("Purpose in 1-2 sentences?", "");
    }
  }

  // Toolsets
  let toolsets = args["toolsets"] || "";
  if (!toolsets) {
    toolsets = await q("Toolsets? (comma-separated)", "web,file");
  }

  // Budget
  let budget = args["budget"] || "";
  if (!budget) {
    budget = await q("Monthly budget in USD?", "5");
  }

  // Telegram token
  let telegramToken = args["telegram-token"] || "";
  if (!telegramToken) {
    telegramToken = await q("Telegram bot token? (leave blank to skip gateway setup)", "");
  }

  // Terminal access
  let terminalAccess = "n";
  if (args["toolsets"]) {
    // In non-interactive mode with explicit toolsets, skip terminal question
    terminalAccess = "n"; // toolsets already handled by --toolsets
  } else {
    const ans = await q("Terminal access? (y/n)", "n");
    terminalAccess = ans.toLowerCase();
  }

  rl.close();
  return { donor, companyPrefix, role, title, purpose, toolsets, budget: Number(budget), telegramToken, terminalAccess };
}

// ── Step 3: Create Hermes profile ────────────────────────────────────
function createProfile(profileName, donor) {
  console.log(`\n▶ Creating profile "${profileName}" from donor "${donor}"...`);
  try {
    execSync(`hermes profile create ${profileName} --clone --clone-from ${donor}`, {
      stdio: "inherit",
    });
    console.log(`✅ Profile "${profileName}" created.`);
  } catch (err) {
    console.error("❌ Failed to create profile. Check hermes CLI is installed and donor exists.");
    process.exit(1);
  }
}

function writeSoulMd(profileName, title, companyPrefix, purpose) {
  const soulPath = path.join(PROFILES_DIR, profileName, "SOUL.md");
  const profileDir = path.join(PROFILES_DIR, profileName);

  // If dir doesn't exist (clone failed), create it
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const content = `You are the ${title} for ${companyPrefix}. ${purpose}
`;
  fs.writeFileSync(soulPath, content, "utf-8");
  console.log(`✅ SOUL.md written to ${soulPath}`);
}

function updateTerminalCwd(profileName, companyPrefix, role) {
  const configPath = path.join(PROFILES_DIR, profileName, "config.yaml");
  if (!fs.existsSync(configPath)) return;

  const config = yaml.load(fs.readFileSync(configPath, "utf-8"));

  if (!config.terminal) config.terminal = {};

  // Set terminal.cwd based on role and prefix
  if (companyPrefix === "shelfscout" && role === "cto") {
    config.terminal.cwd = `~/${companyPrefix}`;
  } else {
    config.terminal.cwd = "~";
  }

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), "utf-8");
  console.log(`✅ terminal.cwd set to "${config.terminal.cwd}"`);
}

function updatePlatformToolsets(profileName, toolsetsList) {
  const configPath = path.join(PROFILES_DIR, profileName, "config.yaml");
  if (!fs.existsSync(configPath)) return;

  const config = yaml.load(fs.readFileSync(configPath, "utf-8"));

  // Ensure platform_toolsets exists
  if (!config.platform_toolsets) config.platform_toolsets = {};
  if (!config.platform_toolsets.telegram) config.platform_toolsets.telegram = [];

  // Convert comma-separated string to array if needed
  const tsArray = Array.isArray(toolsetsList)
    ? toolsetsList
    : toolsetsList.split(",").map((s) => s.trim()).filter(Boolean);

  config.platform_toolsets.telegram = tsArray;

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), "utf-8");
  console.log(`✅ platform_toolsets.telegram set to: [${tsArray.join(", ")}]`);
}

function appendToEnv(profileName, key, value) {
  const envPath = path.join(PROFILES_DIR, profileName, ".env");
  const line = `\n${key}=${value}`;
  fs.appendFileSync(envPath, line, "utf-8");
  console.log(`✅ Added ${key} to .env`);
}

function runGatewayCommands(profileName) {
  console.log(`\n▶ Running gateway install for ${profileName}...`);
  try {
    execSync(`hermes gateway install --profile ${profileName}`, {
      stdio: "inherit",
    });
    console.log("✅ Gateway installed.");
  } catch (err) {
    console.warn(`⚠️  Gateway install failed (non-critical): ${err.message}`);
  }

  console.log(`▶ Starting gateway for ${profileName}...`);
  try {
    execSync(`hermes gateway start --profile ${profileName}`, {
      stdio: "inherit",
    });
    console.log("✅ Gateway started.");
  } catch (err) {
    console.warn(`⚠️  Gateway start failed (non-critical): ${err.message}`);
  }
}

// ── Step 4: Register in Paperclip ────────────────────────────────────
function registerInPaperclip(title, role, profileName, toolsets, budget) {
  console.log(`\n▶ Registering agent in Paperclip at ${PAPERCLIP_API}...`);

  const payload = JSON.stringify({
    name: title,
    role,
    adapter: "hermes-paperclip-adapter",
    profile: profileName,
    toolsets,
    monthlyBudgetUsd: budget,
    companyId: PAPERCLIP_COMPANY_ID,
  });

  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" -X POST ${PAPERCLIP_API} ` +
        `-H "Content-Type: application/json" ` +
        `-d '${payload.replace(/'/g, "'\\''")}'`,
      { encoding: "utf-8" }
    ).trim();

    if (result.startsWith("2")) {
      console.log("✅ Registered in Paperclip.");
      return true;
    } else {
      console.warn(
        `⚠️  Paperclip returned HTTP ${result}. Agent is still usable via Telegram. ` +
          `Verify the endpoint and companyId against your running Paperclip instance.`
      );
      return false;
    }
  } catch (err) {
    console.warn(
      `⚠️  Could not reach Paperclip at ${PAPERCLIP_API}. Agent is still usable via Telegram. ` +
        `Error: ${err.message}`
    );
    return false;
  }
}

// ── Step 5: Print summary ────────────────────────────────────────────
function printSummary(profileName, donor, toolsets, telegramConfigured, paperclipOk, model, config) {
  console.log(`
══════════════════════════════════════════════════════
  Agent Provisioning Complete
══════════════════════════════════════════════════════

✅ Agent created: ${profileName}
   Cloned from:  ${donor}
   Profile dir:  ${path.join(PROFILES_DIR, profileName)}
   Model:        ${model} (inherited from donor)
   Toolsets:     ${toolsets}
${telegramConfigured ? `   Gateway:      hermes-gateway-${profileName} (systemd)` : ""}
   Paperclip:    ${paperclipOk ? "registered (company ID " + PAPERCLIP_COMPANY_ID + ")" : "⚠️  registration failed — agent still usable via Telegram"}
${telegramConfigured ? `   Telegram:     @${config.telegramPrefix || profileName}_bot` : ""}
`);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv;
  const args = parseArgs(argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Non-interactive mode: check required flags
  const hasRole = args["role"] && args["title"] && args["purpose"] && args["donor"] && args["company-prefix"];
  const nonInteractive = !!hasRole;

  // Step 1: Discover profiles
  const profiles = discoverProfiles();
  if (profiles.length === 0) {
    console.error("No existing Hermes profiles found. At least one donor profile is required.");
    process.exit(1);
  }

  let donor;
  if (nonInteractive) {
    donor = args["donor"];
    if (!profiles.includes(donor)) {
      console.error(
        `Donor profile "${donor}" not found. Available profiles: ${profiles.join(", ")}`
      );
      process.exit(1);
    }
    console.log(`Using donor profile: ${donor}`);
  } else {
    console.log("🚀 hermes-hire — Interactive Agent Provisioner\n");
  }

  // Read donor config
  const donorInfo = readDonorConfig(donor);
  console.log(`Donor model: ${donorInfo.model}`);

  // Step 2: Gather configuration
  let config;
  if (nonInteractive) {
    config = {
      donor,
      companyPrefix: args["company-prefix"],
      role: args["role"],
      title: args["title"],
      purpose: args["purpose"],
      toolsets: args["toolsets"] || "web,file",
      budget: Number(args["budget"] || 5),
      telegramToken: args["telegram-token"] || "",
      terminalAccess: "n", // toolsets set via --toolsets flag
    };
  } else {
    config = await askQuestions(profiles, args);
    donor = config.donor; // update donor from interactive selection
  }

  // Derive profile name
  const profileName = `${config.companyPrefix}-${config.role}`;

  // Process toolsets: remove terminal if terminal access is n
  let toolsets = config.toolsets.split(",").map((s) => s.trim()).filter(Boolean);
  if (config.terminalAccess !== "y") {
    toolsets = toolsets.filter((t) => t !== "terminal");
  }
  const toolsetsStr = toolsets.join(",");

  if (!nonInteractive) {
    console.log(`\n📋 Provisioning summary:`);
    console.log(`   Profile:  ${profileName}`);
    console.log(`   Title:    ${config.title}`);
    console.log(`   Toolsets: ${toolsetsStr}`);
    console.log(`   Budget:   $${config.budget}/mo`);
    console.log(`   Telegram: ${config.telegramToken ? "configured" : "skipped"}`);
    console.log();
  }

  // Step 3: Create profile
  createProfile(profileName, config.donor);
  writeSoulMd(profileName, config.title, config.companyPrefix, config.purpose);
  updateTerminalCwd(profileName, config.companyPrefix, config.role);
  updatePlatformToolsets(profileName, toolsets);

  if (config.telegramToken) {
    appendToEnv(profileName, "TELEGRAM_BOT_TOKEN", config.telegramToken);
    runGatewayCommands(profileName);
  }

  // Step 4: Paperclip registration
  const paperclipOk = registerInPaperclip(
    config.title,
    config.role,
    profileName,
    toolsetsStr,
    config.budget
  );

  // Step 5: Summary
  printSummary(
    profileName,
    config.donor,
    toolsetsStr,
    !!config.telegramToken,
    paperclipOk,
    donorInfo.model,
    { telegramPrefix: `${config.companyPrefix}_${config.role}` }
  );
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
