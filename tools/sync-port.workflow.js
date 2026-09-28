export const meta = {
  name: 'onchainos-lite-sync-port',
  description: 'Port one upstream drift report into onchainos-lite: one agent per changed partition, then a verifier',
  whenToUse: 'After `node tools/sync-upstream.mjs --apply`; pass the drift JSON (spec/drift/<old>..<new>.json) as args',
  phases: [{ title: 'Port', detail: 'one agent per changed partition' }, { title: 'Verify', detail: 'coverage gate + full parity' }],
}

const ROOT = 'D:/Job/okx/muse-research/onchainos-lite'
const drift = typeof args === 'string' ? JSON.parse(args) : args
if (!drift || !drift.partitions) throw new Error('pass the drift report JSON as args')

const partitions = Object.entries(drift.partitions)
log(`${drift.from.version} → ${drift.to.version}: ${partitions.length} changed partitions`)

const surface = drift.surface ? JSON.stringify({ added: drift.surface.added, removed: drift.surface.removed, changed: drift.surface.changed }) : 'n/a'

const ported = await parallel(partitions.map(([id, files]) => () => agent(
  `You port an upstream onchainos change into onchainos-lite (root ${ROOT}). Read docs/IMPLEMENTING.md and docs/SYNC.md first.
Upstream moved ${drift.from.version} (${drift.from.commit}) → ${drift.to.version} (${drift.to.commit}); upstream/ is checked out at the new commit.
Partition: ${id}. Changed files: ${JSON.stringify(files)}.
Read the diff: git -C upstream diff ${drift.from.commit} ${drift.to.commit} -- ${files.map((f) => f.path).join(' ')}
Command-surface drift (all partitions): ${surface}
Do: (1) update spec/extract/${id}.md for the changed behaviour; (2) port the change into the lite files owned by this partition (spec/partitions.json); (3) add/adjust parity cases; (4) run node tools/check.mjs and the partition's parity cases until clean. Edit only this partition's files.
Return a short report: what changed upstream, what you changed, test results, anything left.`,
  { label: `port:${id}`, phase: 'Port' })))

const verify = await agent(
  `Final verifier for the ${drift.from.version} → ${drift.to.version} port of onchainos-lite (root ${ROOT}).
Run: node tools/check.mjs; node test/parity/run.mjs; node --test test/unit/. Fix remaining failures (any file), then update docs/PARITY.md divergences if needed.
Partition reports: ${JSON.stringify(ported)}
Return: final status of the three commands and the list of fixes.`,
  { label: 'verify-sync', phase: 'Verify' })

return { ported, verify }
