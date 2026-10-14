import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@upstream/core"],
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default config;
