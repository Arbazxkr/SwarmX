import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-require-imports": "off",
            "no-console": "off",
            "no-constant-condition": "off",
            "no-empty": "off",
            "no-case-declarations": "off",
            "no-useless-escape": "warn",
            "preserve-caught-error": "off",
            "prefer-const": "warn",
        },
    },
    {
        ignores: ["dist/", "node_modules/", "examples/", "apps/"],
    },
);
