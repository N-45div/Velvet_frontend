/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    webpack: (config, { isServer }) => {
        config.experiments = {
            ...config.experiments,
            asyncWebAssembly: true,
        };

        config.module.rules.push({
            test: /\.wasm$/,
            type: 'asset/resource',
        });

        // ShadowWire SDK uses Node.js fs module for ZK proof generation
        // This fallback allows client-side imports while actual ZK ops happen server-side
        if (!isServer) {
            config.resolve.fallback = {
                ...config.resolve.fallback,
                fs: false,
                path: false,
                crypto: false,
            };
        }
        return config;
    },
};

export default nextConfig;
