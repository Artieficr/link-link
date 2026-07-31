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
        // Points at a dedicated tsconfig (not the build's own tsconfig.json)
        // that explicitly includes this very file via allowJs — so that
        // however a given tool ends up type-aware-linting eslint.config.js
        // (Obsidian's review pipeline apparently does, regardless of the
        // `files` restriction above), it resolves real types instead of
        // `any`, rather than relying solely on file-scoping to dodge it.
        project: "./tsconfig.eslint.json",
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
