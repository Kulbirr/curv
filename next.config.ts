import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // @solana/web3.js requires 'rpc-websockets' at import time, and that
      // package requires the ESM-only uuid@14, crashing every serverless
      // function with ERR_REQUIRE_ESM. Curv is REST-only and never opens a
      // websocket subscription, so the server bundle uses a stub instead.
      config.resolve.alias = {
        ...config.resolve.alias,
        'rpc-websockets': path.join(__dirname, 'src/lib/rpc-websockets-stub.ts'),
      };
    }
    return config;
  },
};

export default nextConfig;
