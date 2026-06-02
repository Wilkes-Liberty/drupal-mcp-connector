/**
 * ESLint flat config with security plugin.
 * Run: npm run lint
 */

import securityPlugin from "eslint-plugin-security";
import nodePlugin      from "eslint-plugin-n";
import globals         from "globals";

export default [
  // Apply to all JS source files
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion:  2022,
      sourceType:   "module",
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      security: securityPlugin,
      n:        nodePlugin,
    },
    rules: {
      // --- Security (eslint-plugin-security) --------------------------------
      "security/detect-eval-with-expression":         "error",
      "security/detect-non-literal-fs-filename":      "error",
      "security/detect-non-literal-regexp":           "warn",
      "security/detect-object-injection":             "warn",
      "security/detect-possible-timing-attacks":      "error",
      "security/detect-pseudoRandomBytes":            "error",
      "security/detect-unsafe-regex":                 "error",
      "security/detect-buffer-noassert":              "error",
      "security/detect-child-process":                "error",  // flag exec/spawn
      "security/detect-disable-mustache-escape":      "error",
      "security/detect-new-buffer":                   "error",
      "security/detect-no-csrf-before-method-override": "error",

      // --- Node (eslint-plugin-n) --------------------------------------------
      "n/no-process-exit":           "off",   // we use process.exit intentionally
      "n/no-unsupported-features/es-syntax": "off",

      // --- General best practices -------------------------------------------
      "no-eval":                     "error",
      "no-implied-eval":             "error",
      "no-new-func":                 "error",
      "no-proto":                    "error",
      "no-script-url":               "error",
      "no-var":                      "error",
      "prefer-const":                "error",
      "eqeqeq":                      ["error", "always"],
      "no-console":                  ["warn", { allow: ["error", "warn"] }],
      "no-unused-vars":              ["error", { argsIgnorePattern: "^_" }],
      "prefer-promise-reject-errors": "error",

      // --- Code style -------------------------------------------------------
      "semi":                        ["error", "always"],
      "quotes":                      ["error", "double"],
      "indent":                      ["error", 2, { SwitchCase: 1 }],
      "no-trailing-spaces":          "error",
      "eol-last":                    "error",
    },
  },

  // Ignore test fixtures and generated files
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**"],
  },
];
