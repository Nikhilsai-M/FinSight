import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [".next/**", "prisma/generated/**"],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      "no-unused-vars": "warn",
    },
  },
];

export default eslintConfig;
