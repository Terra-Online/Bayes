import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["node_modules/**", "dist/**", ".wrangler/**"]
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Request: "readonly",
        Response: "readonly",
        fetch: "readonly",
        console: "readonly",
        crypto: "readonly"
      }
    },
    rules: {
      "no-console": ["warn", { "allow": ["error", "warn"] }]
    }
  }
];
