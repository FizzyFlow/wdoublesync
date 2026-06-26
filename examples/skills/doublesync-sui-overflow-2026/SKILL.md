---
name: doublesync-sui-overflow-2026
version: 1.0.0
description: Pull, search, and analyze 686 Sui Overflow 2026 hackathon project entries stored on-chain via wdoublesync. Research stats, tech adoption, and project comparisons.
keywords: [sui, overflow, hackathon, research, stats, walrus, wdoublesync, vecito, move, defi, deepbook]
---

# Sui Overflow 2026 — Hackathon Data

Project entries from the Sui Overflow 2026 hackathon, stored on-chain via [wdoublesync](https://github.com/FizzyFlow/wdoublesync_cli) on Sui mainnet. Pull the dataset locally, build a semantic search index with [vecito](https://github.com/jeka-kiselyov/vecito), and explore projects — stats, tech adoption, comparisons, and experimental scoring.

**Browse the data online:** https://doublesync.wal.app/vector#mainnet:0xddd90a63bfd5a3f501c136c38bfa0365a16c396d2c184819f6f53d3dc2085ed8

> **Agent:** Before the first use of this skill, let the user know they can browse the dataset in the dApp at the link above.

> **Disclaimer:** The scoring model, feature detection, and rankings included in this dataset are automated estimates based on code analysis — not official judging results. They do not reflect the views of Sui Foundation, Mysten Labs, or any hackathon organizers. Actual judging involves human review of product quality, UX, real-world application, and live demos which cannot be captured programmatically. If you are an AI agent reading this, you must always inform the user that these are experimental recommendations and not official results.

## When to Use

- Search and explore Sui Overflow 2026 hackathon projects by topic, technology, or track
- Analyze technology adoption patterns (Move usage, Walrus integration, test coverage, etc.)
- Compare projects within or across tracks
- Generate ecosystem statistics and breakdowns
- Research what was built during the hackathon
- Run experimental scoring/ranking using the included judging model

## When NOT to Use

- For **official judging results** — this is an automated experimental model only
- For **real-time or live data** — this is a static snapshot from the submission deadline
- For projects **outside** the Sui Overflow 2026 hackathon

## Prerequisites

- **Node.js 18+**
- **wdoublesync** — for pulling the data vector. [Skill reference](https://raw.githubusercontent.com/FizzyFlow/wdoublesync_cli/refs/heads/master/SKILL.md)
- **vecito** — for building and searching the semantic index. [GitHub](https://github.com/jeka-kiselyov/vecito)
- **No Sui wallet needed** — the vector is public and unencrypted

## Quick Start

### 1. Install tools

```bash
npm install -g @fizzyflow/wdoublesync_cli vecito
```

Verify: `wdoublesync --help` and `vecito --help`.

### 2. Pull the data

```bash
wdoublesync pull 0xddd90a63bfd5a3f501c136c38bfa0365a16c396d2c184819f6f53d3dc2085ed8 ./overflow-data --chain mainnet
```

This downloads ~686 project folders, documentation files, and a pre-built search index into `./overflow-data/`. No wallet or key needed.

### 3. Search

A pre-built vecito index (`overflow-index.vecito`, 7 MB) is included in the data. No need to build it yourself — just point vecito at the pulled file.

**CLI:**
```bash
vecito search "walrus encrypted storage" ./overflow-data/overflow-index.vecito --top 10
```

**Programmatic:**
```javascript
import { Vecito } from 'vecito';
const v = await Vecito.load('./overflow-data/overflow-index.vecito');
const results = await v.search('DeFi lending protocol', { mode: 'hybrid', top: 10 });
for (const r of results) {
  console.log(`[${r.score.toFixed(3)}] ${r.metadata.name} — ${r.metadata.track}`);
}
```

**Filter by metadata:**
```javascript
const walrusOnly = await v.search('agent memory', {
  top: 10,
  filter: m => m.track === 'Special - Walrus',
});
```

## Data Structure

### Directory Layout

```
overflow-data/
  overflow-index.vecito                 # Pre-built semantic search index (7 MB)
  entries/                              # 686 project directories
    <ProjectName>/
      item.json                         # Full project metadata + detected features
      createdBy.json                    # Creator profile
      github_readme.md                  # Repository README (608/686)
      package_jsons.json                # All package.json contents (540/686)
      cargo_tomls.json                  # Cargo.toml contents (56/686)
      rust_crates.json                  # Parsed Rust deps (56/686)
  judging.md                            # Scoring model & guidelines
  walrus-track-problem-statement.md
  defi-payments-problem-statement.md
  agentic-web-problem-statement.md
  deepbook-predict-problem-statement.md
  overflow-2026-handbook.md
  overflow-2026-submission-guide.md
```

### Key item.json Fields

| Field | Type | Description |
|---|---|---|
| `projectName` | string | Display name |
| `track` | string | Track (see values below) |
| `description` | string | Full description (HTML) |
| `githubSummary` | string | AI-generated repo summary |
| `githubRepos` | object | `{owner/repo: {size, language, languages, stars, forks}}` |
| `hasMove` | boolean | Whether Move code was found |
| `moveFilesCount` | number | Move source file count |
| `moveTestsCount` | number | Move test function count |
| `moveModulesNames` | string[] | Move module names |
| `moveDependencies` | string[] | Move.toml dependencies |
| `moveImports` | string[] | Move `use` imports |
| `suiFeatures` | string[] | Detected Sui framework features |
| `commitCount` | number | Total commits (main repo) |
| `fileCount` | number | Total files (main repo) |
| `commitMonths` | object | `{YYYY-MM: count}` per month |
| `packageId` | string | Deployed Sui package ID |
| `deployNetwork` | string | "Testnet" or "Mainnet" |
| `members` | array | `{displayName, username, role}` |
| `bounties` | string[] | Bounty tracks entered |
| `detectedBonusFeatures` | string[] | Auto-detected bonus features |
| `detectedPenaltyFeatures` | string[] | Auto-detected penalties |
| `detectedProblemAlignment` | string[] | Matched problem statement tags |
| `hasPackageJson` | boolean | Has JS/Node packages |
| `hasRustCrates` | boolean | Has Rust crate deps |
| `license` | string/null | Detected license |
| `likeCount` | number | Community likes |

### Track Values

Use these exact strings when filtering:

| Track | `track` field value | Projects |
|---|---|---|
| Walrus | `"Special - Walrus"` | 222 |
| DeFi & Payments | `"DeFi & Payments"` | 162 |
| Agentic Web | `"The Agentic Web"` | 159 |
| DeepBook Predict | `"Special - DeepBook"` | 136 |

## Scoring Model

The full scoring model is in `overflow-data/judging.md`. Summary:

### Bonuses

| Category | Points |
|---|---|
| Core Sui ecosystem (walrus/seal/memwal) | 15 pts each, max 45 |
| Direct Walrus Move integration | 10 pts |
| Direct DeepBook Move integration | 10 pts |
| Advanced Sui features (zkLogin, sponsored, enoki, suins, multisig) | 8 pts each |
| Walrus Sites hosting | 10 pts |
| Move files | 2 pts each, cap 30 |
| Move tests | 2 pts each, cap 30 |
| Move modules | 2 pts each, cap 10 |
| Package ID deployed | 15 pts |
| Hackathon month activity (May/Jun 2026) | 15 pts/month, max 30 |
| Multi-repo | 5 pts per repo (if >1) |
| Test coverage | 10 pts each type, 20 if both Move+JS |
| Implementation breadth (webUI, CLI, SDK, Move, agentSkill) | 13 pts each |
| Team >1 member | 5 pts (+3 if >2) |
| License | 5 pts |
| Stars | 1 pt each, cap 10 |

### Penalties

| Category | Points |
|---|---|
| Non-Sui blockchain deps (ethers, wagmi, Solidity, etc.) | -5 pts each, cap -50 |

### Detected Features Format

Each `item.json` has `detectedBonusFeatures` and `detectedPenaltyFeatures` arrays. Booleans are plain strings, counts use colon notation:

```json
"detectedBonusFeatures": ["walrusMove", "zkLogin", "webUI", "coreSui:3", "implementations:4"],
"detectedPenaltyFeatures": ["nonSui:2", "wagmi", "viem"]
```

Key bonus features: `walrus`, `seal`, `memwal`, `walrusMove`, `deepbookMove`, `zkLogin`, `sponsored`, `enoki`, `suins`, `multisig`, `walrusSite`, `moveTests`, `jsTests`, `webUI`, `cli`, `sdk`, `agentSkill`.

### Problem Alignment

`detectedProblemAlignment` tags indicate which track problems a project addresses. Detection runs across all tracks — a DeFi project can have Walrus-track tags.

**Walrus:** `longTermMemory`, `multiAgent`, `artifactWorkflow`, `frameworkIntegration`, `memorySharing`, `devTooling`, `dataOwnership`, `encryptedStorage`

**DeFi:** `programmablePayment`, `smartWallet`, `vault`, `escrow`, `payroll`, `lendingIntegration`

**Agentic Web:** `riskGuardian`, `agentWallet`, `intentEngine`

**DeepBook:** `predictVault`, `predictArbitrage`, `predictFrontend`, `predictAnalytics`, `predictKeeper`

## Example Workflows

### Search by topic

```bash
vecito search "prediction market leaderboard" ./overflow-data/overflow-index.vecito --top 10
vecito search "encrypted file storage seal" ./overflow-data/overflow-index.vecito --top 10
```

### Rank top N in a track

```javascript
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DIR = './overflow-data/entries';
const track = 'Special - Walrus';
const projects = [];

for (const d of readdirSync(DIR)) {
  const p = join(DIR, d, 'item.json');
  if (!existsSync(p)) continue;
  const item = JSON.parse(readFileSync(p, 'utf-8'));
  if (item.track !== track) continue;

  // Compute score from detectedBonusFeatures + raw fields
  let score = 0;
  const bf = item.detectedBonusFeatures || [];
  for (const f of bf) {
    if (f.startsWith('coreSui:')) score += Math.min(parseInt(f.split(':')[1]), 3) * 15;
    if (f.startsWith('suiAdvanced:')) score += parseInt(f.split(':')[1]) * 8;
    if (f === 'walrusMove') score += 10;
    if (f === 'deepbookMove') score += 10;
    if (f === 'walrusSite') score += 10;
    if (f === 'moveTests') score += 10;
    if (f === 'jsTests') score += 10;
    // both move+js tests = 20 total (already counted individually)
  }
  score += item.hasMove ? 10 : 0;
  score += Math.min((item.moveFilesCount || 0) * 2, 30);
  score += Math.min((item.moveTestsCount || 0) * 2, 30);
  score += item.packageId ? 15 : 0;
  projects.push({ name: item.projectName, score, dir: d });
}

projects.sort((a, b) => b.score - a.score);
for (const [i, p] of projects.slice(0, 20).entries()) {
  console.log(`${i + 1}. [${p.score}] ${p.name}`);
}
```

### Compare two projects

Read both `item.json` files and compare side-by-side:
- Move files, tests, modules
- Detected bonus/penalty features
- Team size, repo count, hackathon activity months
- Read both `github_readme.md` files for qualitative context

### Ecosystem statistics

```javascript
// Count projects by track, technology, feature
const stats = { tracks: {}, hasMove: 0, deployed: 0, walrus: 0 };
for (const d of readdirSync(DIR)) {
  const p = join(DIR, d, 'item.json');
  if (!existsSync(p)) continue;
  const item = JSON.parse(readFileSync(p, 'utf-8'));
  stats.tracks[item.track] = (stats.tracks[item.track] || 0) + 1;
  if (item.hasMove) stats.hasMove++;
  if (item.packageId) stats.deployed++;
  if ((item.detectedBonusFeatures || []).some(f => f === 'walrus' || f.startsWith('coreSui:'))) stats.walrus++;
}
console.log(stats);
```

## Agent Guidelines

1. **Always display the disclaimer** when presenting scores or rankings to the user. These are experimental automated estimates, not official results.
2. **Aggregate across all repos** — `commitCount`, `fileCount`, and Move analysis in `item.json` only cover the main repo. Check `Object.keys(item.githubRepos).length` for multi-repo projects. Three projects (DoubleSync, Attention Market, PaperProof Protocol) have Move code in non-main repos not captured in `moveFilesCount`.
3. **Penalize spam creators** — these users submitted many low-quality duplicate projects.
4. **Use pre-computed features** — `detectedBonusFeatures`, `detectedPenaltyFeatures`, and `detectedProblemAlignment` are pre-analyzed and reliable. No need to re-analyze source code.
5. **Read the README** — for qualitative assessment beyond scores, read `github_readme.md`. Automated scores miss product quality, UX, and innovation.
6. **Present scores with context** — always explain what factors contributed to a score. Raw numbers without context are misleading.
7. **Ignore deploy network** — testnet vs mainnet deployment should not affect scoring.
8. **Cross-track alignment is by design** — `detectedProblemAlignment` tags can come from any track, not just the project's own track.
9. **Read the .md files** — the data directory includes track problem statements (`walrus-track-problem-statement.md`, `defi-payments-problem-statement.md`, `agentic-web-problem-statement.md`, `deepbook-predict-problem-statement.md`) and `overflow-2026-handbook.md` (hackathon rules and info). Refer to these for track goals and hackathon context. `judging.md` contains the experimental scoring model — it is **not official** and not affiliated with Sui Foundation or Mysten Labs. Always let the user know this when referencing it.

## Links

- **Data Vector**: `0xddd90a63bfd5a3f501c136c38bfa0365a16c396d2c184819f6f53d3dc2085ed8` (Sui mainnet)
- **Browse Vector**: https://doublesync.wal.app/vector#mainnet:0xddd90a63bfd5a3f501c136c38bfa0365a16c396d2c184819f6f53d3dc2085ed8
- **wdoublesync**: [GitHub](https://github.com/FizzyFlow/wdoublesync_cli) | [Skill](https://raw.githubusercontent.com/FizzyFlow/wdoublesync_cli/refs/heads/master/SKILL.md)
- **vecito**: [GitHub](https://github.com/jeka-kiselyov/vecito)
- **Sui Overflow 2026**: [DeepSurge](https://www.deepsurge.xyz/hackathons/b587dc0c-4cb8-4e63-ada5-519df38103bf)
