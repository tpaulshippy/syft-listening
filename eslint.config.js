import js from "@eslint/js"
import globals from "globals"

export default [
  { ignores: ["node_modules/**", "vendor/**", "app/assets/builds/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // Propshaft serves each controller file as a standalone fingerprinted
    // asset, so relative ESM imports 404 and the whole controller silently
    // fails to register. Keep controllers self-contained instead.
    files: ["app/javascript/controllers/*.js"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["./*", "../*"] }],
    },
  },
]
