// upgrade — upstream cli/src/commands/upgrade.rs.
// Upstream `onchainos upgrade` runs `npx -y @okxweb3/onchainos-installer install`, which installs
// the Rust onchainos binary (and is what fails in sandboxes such as Muse). onchainos-lite never
// spawns npx: `upgrade` fails with upstream's failed-upgrade envelope ({"ok":false,"error":…},
// exit 1) and explains that lite is updated by replacing the skill folder (docs/SYNC.md).
// `preflight` (same upstream file) lives in commands/preflight/.
import { existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { UPSTREAM_VERSION, LITE_VERSION } from '../../config.mjs';

// The installer command upstream runs (upgrade.rs::execute).
export const INSTALLER_COMMAND = 'npx -y @okxweb3/onchainos-installer install';

// upstream: upgrade.rs::SKILL_INSTALL_PATHS / SKILL_HOME_DIRS
export const SKILL_INSTALL_PATHS = [
  '.codex/onchainos-skills',
  '.openclaw/onchainos-skills',
  '.cursor/onchainos-skills',
  '.config/opencode/onchainos-skills',
  '.claude/onchainos-skills',
];
export const SKILL_HOME_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.openclaw/skills',
  '.cursor/skills',
];

// Lite's answer to `onchainos upgrade` (intentional divergence, docs/PARITY.md).
export function liteUpgradeMessage() {
  return `\`onchainos upgrade\` is not available in onchainos-lite: upstream runs \`${INSTALLER_COMMAND}\`, `
    + `which installs the Rust onchainos CLI. onchainos-lite ${LITE_VERSION} (parity with onchainos ${UPSTREAM_VERSION}) `
    + 'is updated by replacing the skill folder with a newer release; your state and login are kept (see docs/SYNC.md)';
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const canonical = (p) => { try { return realpathSync.native(p); } catch { return p; } };

// upstream: upgrade.rs::discover_skill_paths_in — existing monorepo install paths, then every
// sub-directory of the per-skill homes (directory order), de-duplicated by canonical path.
export function discoverSkillPathsIn(home) {
  const monorepo = SKILL_INSTALL_PATHS.map((rel) => join(home, rel)).filter((p) => existsSync(p));
  const perSkill = SKILL_HOME_DIRS.map((rel) => join(home, rel)).filter(isDir).flatMap((dir) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return []; }
    return names.map((n) => join(dir, n)).filter(isDir);
  });
  const seen = new Set();
  return [...monorepo, ...perSkill].filter((p) => {
    const key = canonical(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// upstream: upgrade.rs::is_skill_installed_in — a discovered path named `skillId` holding a
// regular SKILL.md file (used by agent-commerce autotrade).
export function isSkillInstalledIn(home, skillId) {
  return discoverSkillPathsIn(home).some((p) => basename(p) === skillId && isFile(join(p, 'SKILL.md')));
}

export default {
  upgrade: {
    uses: [],
    // upstream: upgrade.rs::execute — lite never runs the npx installer.
    async run() {
      throw new Error(liteUpgradeMessage());
    },
  },
};
