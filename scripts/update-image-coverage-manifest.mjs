import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const atlosRoot = resolve(process.argv[2] ?? resolve(repositoryRoot, "../Atlos/talos"));
const markerRoot = resolve(atlosRoot, "src/data/marker");
const outputPath = resolve(repositoryRoot, "src/data/imageCoverageManifest.json");

const uploadableCategories = new Set(["collection", "archives", "exploration"]);
const categoryOrder = ["collection", "archives", "exploration"];
const categoryNames = {
  collection: "收集物",
  archives: "档案",
  exploration: "探索"
};
const regions = {
  VL: {
    name: "四号谷地",
    subregions: ["VL_1", "VL_2", "VL_3", "VL_5", "VL_6", "VL_7"]
  },
  WL: {
    name: "武陵",
    subregions: ["WL_1", "WL_2", "WL_3", "WL_4", "WL_5", "WL_6", "WL_7", "WL_8"]
  }
};

const markerTypes = readJson(resolve(markerRoot, "type.json"));
const translations = readJson(resolve(atlosRoot, "src/locale/data/game/zh-cn.json"));
const typeNames = translations.markerType?.key ?? {};
const typeOrder = new Map(Object.keys(markerTypes).map((key, index) => [key, index]));

const manifestRegions = Object.fromEntries(Object.entries(regions).map(([regionKey, region]) => {
  const grouped = new Map();

  for (const subregion of region.subregions) {
    const markers = readJson(resolve(markerRoot, "data", `${subregion}.json`));
    for (const rawMarker of markers) {
      const markerId = String(Array.isArray(rawMarker) ? rawMarker[0] : rawMarker.id);
      const typeKey = String((Array.isArray(rawMarker) ? rawMarker[5] : rawMarker.type) ?? "");
      const category = markerTypes[typeKey]?.category?.sub;
      if (!uploadableCategories.has(category)) continue;

      const groupKey = category === "archives" ? "archives" : typeKey;
      const group = grouped.get(groupKey) ?? {
        key: groupKey,
        name: category === "archives"
          ? categoryNames.archives
          : String(typeNames[typeKey] ?? markerTypes[typeKey]?.name ?? typeKey),
        category,
        pointIds: []
      };
      group.pointIds.push(markerId);
      grouped.set(groupKey, group);
    }
  }

  const types = [...grouped.values()].sort((left, right) => {
    const categoryDelta = categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category);
    if (categoryDelta !== 0) return categoryDelta;
    if (left.key === "archives") return -1;
    if (right.key === "archives") return 1;
    return (typeOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER)
      - (typeOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER);
  });

  return [regionKey, {
    name: region.name,
    types
  }];
}));

const sourceCommit = execFileSync("git", ["-C", atlosRoot, "rev-parse", "HEAD"], {
  encoding: "utf8"
}).trim();
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit,
  regions: manifestRegions
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest)}\n`);

const pointCount = Object.values(manifestRegions).reduce(
  (regionTotal, region) => regionTotal + region.types.reduce(
    (typeTotal, type) => typeTotal + type.pointIds.length,
    0
  ),
  0
);
console.log(`Wrote ${pointCount} uploadable WL/VL points to ${outputPath}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
