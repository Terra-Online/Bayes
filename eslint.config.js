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
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)\\.\\.(/|$)",
              message: "Use @/ for imports across directories instead of parent-relative paths.",
            },
          ],
        },
      ],
      // no-restricted-imports only checks static imports and re-exports.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression > Literal[value=/(^|\\u002f)\\.\\.(\\u002f|$)/]",
          message: "Use @/ for dynamic imports across directories.",
        },
        {
          selector: "TSImportType > Literal[value=/(^|\\u002f)\\.\\.(\\u002f|$)/]",
          message: "Use @/ for import types across directories.",
        },
        {
          selector:
            'CallExpression[callee.object.name="vi"][callee.property.name=/^(mock|doMock|unmock|doUnmock|importActual|importMock)$/] > Literal.arguments[value=/(^|\\u002f)\\.\\.(\\u002f|$)/]:first-child',
          message: "Use @/ for test module paths across directories.",
        },
      ],
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
