import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  { ignores: ["main.js", "esbuild.config.mjs", "eslint.config.js"] },
  ...obsidianmd.configs.recommended,
  {
    // Scoped to *.ts only: tsconfig.json's "include" is ["*.ts"], so type-aware
    // parserOptions.project can't resolve real types for this file itself (or
    // any other non-.ts file) — attaching it more broadly makes every
    // identifier here resolve to `any`, tripping @typescript-eslint's
    // no-unsafe-* rules against this very config.
    files: ["*.ts"],
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
