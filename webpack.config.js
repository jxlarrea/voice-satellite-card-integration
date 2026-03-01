const path = require('path');
const pkg = require('./package.json');
const webpack = require('webpack');

const frontendDir = path.resolve(__dirname, 'custom_components/voice_satellite/frontend');

const baseConfig = {
  entry: './src/index.js',
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
  },
};

module.exports = (env, argv) => {
  if (argv.mode === 'development') {
    // Dev: unminified with source maps (npm run dev)
    return {
      ...baseConfig,
      output: {
        ...baseConfig.output,
        filename: 'voice-satellite-card.js',
        chunkFilename: 'voice-satellite-[name].js',
        path: frontendDir,
      },
      optimization: {
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
      filename: 'voice-satellite-card.js',
      chunkFilename: 'voice-satellite-[name].js',
      path: frontendDir,
    },
    optimization: {
      minimize: true,
    },
  };
};
