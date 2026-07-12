import obsidianmd from "eslint-plugin-obsidianmd";
// Deep import: not part of the package's declared public API, so this could
// break silently on a future eslint-plugin-obsidianmd upgrade. If `pnpm exec
// eslint .` starts failing to load config after a version bump, check here
// first — fall back to hardcoding DEFAULT_BRANDS/DEFAULT_ACRONYMS if the path
// moved.
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default [
  { ignores: ["main.js", "esbuild.config.mjs", "eslint.config.js"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Passing `brands` replaces the rule's default list rather than
      // extending it, so we spread DEFAULT_BRANDS back in alongside our own.
      "obsidianmd/ui/sentence-case": [
        "warn",
        { brands: [...DEFAULT_BRANDS, "Link Link!", "Ollama", "Hugging Face"] },
      ],
    },
  },
];
