# Local data templates

Run these commands from the repository root, after installing dependencies.
Three imported data files are intentionally absent from a public checkout.
Copy the templates only when the destination is absent; local destination files
remain ignored by Git.

```sh
cp -n src/lib/karma/karmaConfig.template.json src/lib/karma/karmaConfig.json
cp -n src/routes/binding/officialMarkerHashToPointId.template.json src/routes/binding/officialMarkerHashToPointId.json
mkdir -p src/data
cp -n templates/imageCoverageManifest.template.json src/data/imageCoverageManifest.json
```

| Template | Local destination | Purpose |
| --- | --- | --- |
| `src/lib/karma/karmaConfig.template.json` | `src/lib/karma/karmaConfig.json` | Numeric schema placeholders; all configurable values are zero. Supply your own policy before exercising karma behavior. |
| `src/routes/binding/officialMarkerHashToPointId.template.json` | `src/routes/binding/officialMarkerHashToPointId.json` | Empty mapping from lowercase official marker hashes to OEM point ID strings. |
| `templates/imageCoverageManifest.template.json` | `src/data/imageCoverageManifest.json` | Empty coverage metadata and region/type point lists; no real coverage totals. |

The templates contain no production policy, mappings, account data, or credentials.
The empty data files allow imports to resolve; they do not enable real game-data
integration. Tests that assume particular karma policy values need an appropriate
local configuration. See the consuming modules for field behavior:

- Karma policy: `src/lib/karma/rules.ts`.
- Official point mapping: `src/services/official/officialMarks.ts`.
- Coverage manifest: `src/services/moderation/imageCoverage.ts`.

With the Atlos game data available, regenerate the coverage manifest:

```sh
pnpm run coverage-manifest:update -- ../Atlos/talos
```

Review the generated source metadata and totals before using the manifest for
operational coverage reports. The generator is
[`scripts/update-image-coverage-manifest.mjs`](../scripts/update-image-coverage-manifest.mjs).
