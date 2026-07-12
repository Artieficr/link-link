import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  { ignores: ["main.js", "esbuild.config.mjs", "eslint.config.js"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      // Deliberate: this plugin uses Title Case for named features/sections
      // ("Selection Mode", "Live Mode", "Interlink Vault") as an intentional
      // naming convention, not inconsistent capitalization. Obsidian's
      // strict sentence-case guideline would flag all of these; decided to
      // keep the existing style rather than rewrite established UI copy.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
];
