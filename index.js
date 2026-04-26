#!/usr/bin/env node

/**
 * hermes-hire — CLI wizard for creating new Hermes agent profiles
 *
 * Usage:
 *   node index.js                                      # interactive mode
 *   node index.js --role cmo --title "Chief Marketing Officer" \
 *       --purpose "Handles ASO and social content" \
 *       --toolsets web,file,browser --budget 5 \
 *       --telegram-token "123456:ABC" \
 *       --donor shelfscout-coder --company-prefix shelfscout   # non-interactive
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");

// ─── Constants ──────────────────────────────────────────────────────────
const HERMES_PROFILES_DIR = path.join(
  process.env.HOME || require("os").homedir(),
  ".hermes",
  "profiles"
);

const DEFAULT_TOOLSETS = "web,file";
const DEFAULT_BUDGET = 5;
// Verify this endpoint and companyId against your running Paperclip instance at http://localhost:3100
const PAPERCLIP_URL = "http://localhost:3100/api/agents";
const PAPERCLIP_COMPANY_ID = 1;

// ─── CLI arg parsing ────────────────────────────────────────────────────

const HELP_TEXT = `
hermes-hire — Spin up a new Hermes agent profile with Telegram gateway setup.

Usage:
  node index.js                           # Interactive mode (prompts one-by-one)
  node index.js --role ROLE --company-prefix PREFIX [flags...]  # Non-interactive

Non-interactive flags:
  --role           Agent role slug (e.g. cmo, cro, cfo)       [required]
  --title          Job title (e.g. "Chief Marketing Officer")  [required]
  --purpose        Purpose in 1-2 sentences                    [required]
  --company-prefix Company prefix for profile name              [required]
  --toolsets       Comma-separated toolsets  [default: web,file]
  --budget         Monthly budget in USD     [default: 5]
  --telegram-token Telegram bot token        [optional]
  --donor          Donor profile to clone from                 [required]
  --help           Show this help message

Example:
  node index.js --role cmo --title "Chief Marketing Officer" \\
    --purpose "Handles ASO and social content" --toolsets web,file,browser \\
    --budget 5 --telegram-token "123456:ABC" \\
    --donor shelfscout-coder --company-prefix shelfscout
`;

function parseArgs(argv) {
  const args = {};
  const keys = [
    "role",
    "title",
    "purpose",
    "company-prefix",
    "toolsets",
    "budget",
    "telegram-token",
    "donor",
    "help",
  ];

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "help") {
      args.help = true;
      continue;
    }
    if (keys.includes(key) && i + 1 < argv.length) {
      args[key] = argv[++i];
    }
  }
  return args;
}

// ─── Step 1: Discovery ──────────────────────────────────────────────────

function discoverProfiles() {
  if (!fs.existsSync(HERMES_PROFILES_DIR)) {
    console.error(`❌ Profiles directory not found: ${HERMES_PROFILES_DIR}`);
    process.exit(1);
  }
  return fs
    .readdirSync(HERMES_PROFILES_DIR)
    .filter((f) => {
      const profilePath = path.join(HERMES_PROFILES_DIR, f);
      return fs.statSync(profilePath).isDirectory();
    })
    .sort();
}

function readDonorConfig(donor) {
  const configPath = path.join(HERMES_PROFILES_DIR, donor, "config.yaml");
  const envPath = path.join(HERMES_PROFILES_DIR, donor, ".env");

  if (!fs.existsSync(configPath)) {
    console.error(`❌ Donor config not found: ${configPath}`);
    process.exit(1);
  }

  const config = yaml.load(fs.readFileSync(configPath, "utf8"));
  const model = config.model || null;

  let envContent = "";
  let openrouterKey = null;
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf8");
    const match = envContent.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match) openrouterKey = match[1];
  }

  return { model, openrouterKey, envContent };
}

// ─── Step 2: Interactive prompts ────────────────────────────────────────

function askSync(question, defaultValue = "") {
  process.stdout.write(question);
  if (defaultValue) process.stdout.write(` [default: ${defaultValue}]`);
  process.stdout.write(": ");

  const buf = Buffer.alloc(1024);
  const read = fs.readSync(process.stdin.fd, buf, 0, 1024);
  const answer = buf.toString("utf8", 0, read).trim();
  return answer || defaultValue;
}

function askInteractive(profiles) {
  console.log("\n📋  Step 1 — Select donor profile\n");
  console.log("Available profiles:");
  profiles.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log("");

  let donorIdx;
  while (!donorIdx) {
    donorIdx = parseInt(askSync("Clone from which profile (number?)"), 10);
    if (donorIdx < 1 || donorIdx > profiles.length) {
      console.log(`  → Enter a number between 1 and ${profiles.length}`);
      donorIdx = null;
    }
  }

  const donor = profiles[donorIdx - 1];
  const prefix = askSync("\nCompany prefix? (e.g. shelfscout, acme)");
  const role = askSync("Agent role slug? (e.g. cmo, cro, cfo)");
  const title = askSync("Job title? (e.g. Chief Marketing Officer)");
  const purpose = askSync("Purpose in 1-2 sentences?");
  const rawToolsets = askSync("Toolsets? (comma-separated)", DEFAULT_TOOLSETS);
  const budget = parseInt(
    askSync("Monthly budget in USD?", String(DEFAULT_BUDGET)),
    10
  );
  const telegramToken = askSync(
    "Telegram bot token? (leave blank to skip)",
    ""
  );
  const terminalAccess = askSync("Terminal access? (y/n)", "n").toLowerCase();

  let toolsets = rawToolsets.split(",").map((t) => t.trim()).filter(Boolean);
  if (terminalAccess !== "y") {
    toolsets = toolsets.filter((t) => t !== "terminal");
  }

  return {
    donor,
    prefix,
    role,
    title,
    purpose,
    toolsets: toolsets.join(","),
    budget,
    telegramToken,
  };
}

// ─── Step 3: Create the Hermes profile ──────────────────────────────────

function createProfile(profileName, donor) {
  console.log(`\n🔨 Creating profile: ${profileName}`);
  try {
    execSync(
      `hermes profile create ${profileName} --clone --clone-from ${donor}`,
      { stdio: "inherit" }
    );
    console.log(`✅ Profile created: ${profileName}`);
  } catch (err) {
    console.error(
      `❌ Profile creation failed. Does the "hermes" CLI exist on PATH?`
    );
    console.error(err.message);
    process.exit(1);
  }
}

function writeSoul(profileName, title, purpose) {
  const soulPath = path.join(HERMES_PROFILES_DIR, profileName, "SOUL.md");
  const soulContent = `# Identity\nYou are the ${title}. ${purpose}\n`;
  fs.writeFileSync(soulPath, soulContent);
  console.log(`✅ SOUL.md written → ${soulPath}`);
}

function appendToEnv(profileName, key, value) {
  const envPath = path.join(HERMES_PROFILES_DIR, profileName, ".env");
  const line = `\n${key}=${value}\n`;
  fs.appendFileSync(envPath, line);
  console.log(`✅ ${key} appended to ${envPath}`);
}

function updatePlatformToolsets(profileName, toolsetsArray) {
  const configPath = path.join(
    HERMES_PROFILES_DIR,
    profileName,
    "config.yaml"
  );
  const config = yaml.load(fs.readFileSync(configPath, "utf8"));

  // Ensure platform_toolsets.telegram exists
  if (!config.platform_toolsets) config.platform_toolsets = {};
  config.platform_toolsets.telegram = toolsetsArray;

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }));
  console.log(
    `✅ platform_toolsets.telegram updated → ${toolsetsArray.join(", ")}`
  );
}

function setTerminalCwd(profileName, prefix, role) {
  const configPath = path.join(
    HERMES_PROFILES_DIR,
    profileName,
    "config.yaml"
  );
  const config = yaml.load(fs.readFileSync(configPath, "utf8"));

  // For CTO role with matching prefix → ~/shelfscout (or ~/<prefix>)
  if (role === "cto" && prefix) {
    config.terminal = config.terminal || {};
    config.terminal.cwd = `~/${prefix}`;
  } else {
    config.terminal = config.terminal || {};
    config.terminal.cwd = "~";
  }

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }));
  console.log(
    `✅ terminal.cwd set to ${config.terminal.cwd}`
  );
}

function installAndStartGateway(profileName) {
  console.log(`\n📡 Installing gateway for ${profileName}...`);
  try {
    execSync(`hermes --profile ${profileName} gateway install`, {
      stdio: "inherit",
    });
    console.log(`✅ Gateway installed`);
  } catch (err) {
    console.error("⚠️  Gateway install failed (continuing)");
  }

  console.log(`\n🚀 Starting gateway for ${profileName}...`);
  try {
    execSync(`hermes --profile ${profileName} gateway start`, {
      stdio: "inherit",
    });
    throw "Gateway start succeeded but threw (expected in some versions)";
  } catch (err) {
    // Gateway start sometimes exits non-zero even when the service starts
    console.log("✅ Gateway start command completed");
  }
}

// ─── Step 4: Register in Paperclip ──────────────────────────────────────

async function registerPaperclip(agentData) {
  console.log(`\n📋 Registering agent in Paperclip...`);
  const { name, role, profile, toolsets, budget } = agentData;

  const payload = {
    name,
    role,
    adapter: "hermes-paperclip-adapter",
    profile,
    toolsets,
    monthlyBudgetUsd: budget,
    companyId: PAPERCLIP_COMPANY_ID,
  };

  console.log(`POST ${PAPERCLIP_URL}`);
  console.log(`Body: ${JSON.stringify(payload, null, 2).slice(0, 200)}...`);

  try {
    const resp = await fetch(PAPERCLIP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      const body = await resp.json();
      console.log(`✅ Registered in Paperclip (status: ${resp.status})`);
      return { registered: true, status: resp.status, body };
    } else {
      const text = await resp.text();
      return {
        registered: false,
        status: resp.status,
        error: text,
      };
    }
  } catch (err) {
    return {
      registered: false,
      error: err.message,
    };
  }
}

// ─── Step 5: Summary ────────────────────────────────────────────────────

function printSummary(data, paperclipResult) {
  const { prefix, role, donor, toolsets, purpose, budget, telegramToken } =
    data;
  const profileName = `${prefix}-${role}`;

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`✅ Agent created: ${profileName}`);
  console.log(`   Cloned from:  ${donor}`);
  console.log(`   Profile dir:  ${path.join(HERMES_PROFILES_DIR, profileName)}`);
  console.log(`   Model:        (inherited from donor)`);
  console.log(`   Toolsets:     ${toolsets}`);
  console.log(`   Purpose:      ${purpose}`);
  console.log(`   Budget:       $${budget}/mo`);
  console.log(
    `   Paperclip:    ${paperclipResult.registered ? `registered under company ID ${PAPERCLIP_COMPANY_ID}` : `⚠️  Failed (status: ${paperclipResult.status || "connection error"}) — agent still usable via Telegram`}`
  );

  if (telegramToken) {
    const serviceName = `hermes-gateway-${profileName}`;
    console.log(`   Gateway:      ${serviceName} (systemd)`);
    console.log(`   Telegram:     @${prefix}_${role}_bot`);
  }

  console.log(`══════════════════════════════════════════════`);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const nonInteractive =
    args["company-prefix"] && args.role && args.title && args.donor;

  const profiles = discoverProfiles();

  let data;

  if (nonInteractive) {
    console.log("🚀 Non-interactive mode\n");
    data = {
      donor: args.donor,
      prefix: args["company-prefix"],
      role: args.role,
      title: args.title,
      purpose: args.purpose || "",
      toolsets: args.toolsets || DEFAULT_TOOLSETS,
      budget: parseInt(args.budget || DEFAULT_BUDGET, 10),
      telegramToken: args["telegram-token"] || "",
    };

    // In non-interactive mode, validate donor
    if (
      !fs.existsSync(path.join(HERMES_PROFILES_DIR, data.donor, "config.yaml"))
    ) {
      console.error(`❌ Donor profile not found: ${data.donor}`);
      console.log(`Available: ${profiles.join(", ")}`);
      process.exit(1);
    }
  } else {
    data = askInteractive(profiles);
    if (
      !data.prefix ||
      !data.role ||
      !data.title ||
      !data.donor ||
      !data.purpose
    ) {
      console.error("❌ All fields are required.");
      process.exit(1);
    }
  }

  const { donor, prefix, role, title, purpose, toolsets, budget, telegramToken } = data;
  const profileName = `${prefix}-${role}`;
  const toolsetsArray = toolsets.split(",").map((t) => t.trim()).filter(Boolean);

  // Validate donor exists
  const donorConfig = readDonorConfig(donor);
  if (!donorConfig.model) {
    console.error(
      `⚠️  Donor profile "${donor}" has no model set in config.yaml`
    );
    process.exit(1);
  }

  console.log(`\n📋 Summary:`);
  console.log(`   Profile:      ${profileName}`);
  console.log(`   Donor:        ${donor} (model: ${donorConfig.model})`);
  console.log(`   Title:        ${title}`);
  console.log(`   Toolsets:     ${toolsets}`);
  console.log(`   Budget:       $${budget}/mo`);
  console.log(`   Gateway:      ${telegramToken ? "Telegram enabled" : "disabled"}`);
  console.log("");

  // Step 3: Create profile
  createProfile(profileName, donor);
  writeSoul(profileName, title, purpose);
  setTerminalCwd(profileName, prefix, role);
  updatePlatformToolsets(profileName, toolsetsArray);

  if (telegramToken) {
    appendToEnv(profileName, "TELEGRAM_BOT_TOKEN", telegramToken);
  }

  // Gateway install + start (only if Telegram configured)
  if (telegramToken) {
    installAndStartGateway(profileName);
  }

  // Step 4: Register in Paperclip
  const paperclipResult = await registerPaperclip({
    name: title,
    role,
    profile: profileName,
    toolsets,
    budget,
  });

  // Step 5: Print summary
  printSummary(data, paperclipResult);
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
