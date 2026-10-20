import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "dist/**", ".wrangler/**", ".wrangler-*/**", ".history/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    rules: {
      ...js.configs.recommended.rules,
      curly: ["error", "all"],
      "brace-style": ["error", "1tbs", { allowSingleLine: false }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "no-nested-ternary": "error",
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Request: "readonly",
        Response: "readonly",
        fetch: "readonly",
        console: "readonly",
        crypto: "readonly",
      },
    },
    rules: {
      // TypeScript checks names and unused declarations with the project's types.
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          // Keep module type queries such as typeof import(...) usable in test mocks.
          disallowTypeAnnotations: false,
        },
      ],
    },
  },
];
