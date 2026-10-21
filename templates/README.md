# Local data templates

Copy instructions live in [local development](../docs/development.md#install-and-prepare-data).
Local destination files remain ignored by Git.

| Template | Local destination | Purpose |
| --- | --- | --- |
| `src/lib/karma/karmaConfig.template.json` | `src/lib/karma/karmaConfig.json` | Numeric schema placeholders; all configurable values are zero. Supply your own policy before exercising karma behavior. |
| `src/routes/binding/officialMarkerHashToPointId.template.json` | `src/routes/binding/officialMarkerHashToPointId.json` | Empty mapping from lowercase official marker hashes to OEM point ID strings. |
| `templates/imageCoverageManifest.template.json` | `src/data/imageCoverageManifest.json` | Empty coverage metadata and region/type point lists; no real coverage totals. |

The templates contain no production policy, mappings, account data, or credentials.
The empty data files allow imports to resolve; they do not enable real game-data
integration. See the consuming modules for field behavior:

- Karma policy: `src/lib/karma/rules.ts`.
- Official point mapping: `src/services/sync/officialMarks.ts`.
- Coverage manifest: `src/services/moderation/imageCoverage.ts`.

Karma values are clamped to 0–5 by code. The evaluation interval is also defined
in code rather than a JSON setting. Coverage data can be generated from Atlos;
see [development](../docs/development.md).
