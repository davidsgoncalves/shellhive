// Points an update channel (beta or alpha, the first argument) at this release
// when the channel takes it and it is newer than what the channel serves. A
// channel is a fixed pre-release, tagged <name>-channel, whose latest.json the
// app reads when the user joined it. The alpha channel takes every release;
// the beta channel takes betas and regular versions, never an alpha.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHANNELS = {
  beta: {
    title: "Canal beta",
    notes: "Usado pela atualização automática de quem participa do programa beta. Não baixe daqui; os instaladores ficam em cada versão.",
    takes: (version) => !/-alpha/.test(version),
  },
  alpha: {
    title: "Canal alpha",
    notes: "Usado pela atualização automática de quem participa do programa alpha. Não baixe daqui; os instaladores ficam em cada versão.",
    takes: () => true,
  },
};
const name = process.argv[2];
const channel = CHANNELS[name];
if (!channel) {
  console.error(`usage: channel.mjs ${Object.keys(CHANNELS).join("|")}`);
  process.exit(1);
}
const CHANNEL = `${name}-channel`;
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error("GITHUB_REPOSITORY is required");
  process.exit(1);
}

const gh = (args, opts = {}) => execFileSync("gh", args, { encoding: "utf8", ...opts });

/** Compares two semver versions, pre-release suffixes included. */
function compare(a, b) {
  const split = (v) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  // A release without a suffix is newer than any pre-release of it.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (np !== nq) return np ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const fresh = JSON.parse(readFileSync("latest.json", "utf8"));
if (!channel.takes(fresh.version)) {
  console.log(`${name} channel does not take ${fresh.version}`);
  process.exit(0);
}

let exists = true;
try {
  gh(["release", "view", CHANNEL, "--repo", repo], { stdio: "ignore" });
} catch {
  exists = false;
}
if (!exists) {
  gh([
    "release", "create", CHANNEL, "--repo", repo, "--prerelease", "--latest=false",
    "--title", channel.title,
    "--notes", channel.notes,
  ]);
}

let current = null;
try {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  gh(["release", "download", CHANNEL, "--repo", repo, "--pattern", "latest.json", "--dir", dir]);
  current = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).version;
} catch {
  // A new channel has no manifest yet.
}

if (current && compare(fresh.version, current) < 0) {
  console.log(`${name} channel keeps ${current}, newer than ${fresh.version}`);
  process.exit(0);
}
gh(["release", "upload", CHANNEL, "latest.json", "--clobber", "--repo", repo]);
console.log(`${name} channel now serves ${fresh.version}${current ? ` (was ${current})` : ""}`);
