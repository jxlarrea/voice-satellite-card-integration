const path = require('path');
const pkg = require('./package.json');
const webpack = require('webpack');

const frontendDir = path.resolve(__dirname, 'custom_components/voice_satellite/frontend');

const baseConfig = {
  entry: {
    'voice-satellite-card': './src/index.js',
    'voice-satellite-panel': './src/panel/index.js',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
        },
      },
      {
        test: /\.css$/,
        type: 'asset/source',
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      __VERSION__: JSON.stringify(pkg.version),
    }),
  ],
  // Dynamic import() chunks (e.g. wake-word) are loaded from the same
  // static path as the main card JS (/voice_satellite/).
  output: {
    publicPath: '/voice_satellite/',
    clean: {
      keep: /^fonts\//,
    },
  },
  // Pin chunk names to the file path (e.g. src_wake-word_worker_inference-worker_js)
  // in BOTH dev and prod. Webpack defaults to 'named' in dev and 'deterministic'
  // (numeric like '803') in prod, which produces different chunk URLs between
  // the two modes. A user who locally ran `npm run dev` and then upgraded to a
  // production release would have the dev bundle's chunk URLs cached and get
  // 404s for chunks that the prod bundle renamed. Keeping the names stable
  // also makes production chunks debuggable.
  optimization: {
    chunkIds: 'named',
  },
};

module.exports = (env, argv) => {
  if (argv.mode === 'development') {
    // Dev: unminified with source maps (npm run dev)
    return {
      ...baseConfig,
      output: {
        ...baseConfig.output,
        filename: '[name].js',
        chunkFilename: 'voice-satellite-[name].js',
        path: frontendDir,
      },
      optimization: {
        ...baseConfig.optimization,
        minimize: false,
      },
      devtool: 'source-map',
    };
  }
  // Production: minified, no source map (npm run build / CI)
  return {
    ...baseConfig,
    output: {
      ...baseConfig.output,
      filename: '[name].js',
      chunkFilename: 'voice-satellite-[name].js',
      path: frontendDir,
    },
    optimization: {
      ...baseConfig.optimization,
      minimize: true,
    },
  };
};
