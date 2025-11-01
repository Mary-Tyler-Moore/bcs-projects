/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // This replaced experimental.serverComponentsExternalPackages
  serverExternalPackages: [
    '@google-cloud/bigquery',
    'google-gax',
    'google-auth-library',
    'gaxios',
  ],
};

export default nextConfig;
