import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  { ignores: ["main.js", "esbuild.config.mjs", "eslint.config.js"] },
  ...obsidianmd.configs.recommended,
  {
    // Scoped to *.ts for well-behaved tools (this type-aware block has no
    // reason to apply to eslint.config.js itself). Not load-bearing on its
    // own though — see the `project` comment below for the actual fix.
    files: ["*.ts"],
    languageOptions: {
      parserOptions: {
        // tsconfig.json's own "include" covers this file too (via allowJs) —
        // so however a given tool ends up type-aware-linting eslint.config.js
        // (Obsidian's review pipeline apparently does, regardless of the
        // `files` restriction above, and regardless of a separate tsconfig
        // pointed at from here — a prior attempt using a differently-named
        // tsconfig.eslint.json had no effect, suggesting external tooling
        // doesn't consult this path and instead auto-discovers a file named
        // exactly tsconfig.json), it resolves real types instead of `any`.
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
