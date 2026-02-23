const path = require('path');
const pkg = require('./package.json');
const webpack = require('webpack');

const wwwDir = path.resolve(__dirname, 'custom_components/voice_satellite/www');

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
};

module.exports = (env, argv) => {
  if (argv.mode === 'development') {
    // Dev: unminified with source maps
    return {
      ...baseConfig,
      output: {
        filename: 'voice-satellite-card.js',
        path: wwwDir,
      },
      optimization: {
        minimize: false,
      },
      devtool: 'source-map',
    };
  }
  // Production: minified, no source map
  return {
    ...baseConfig,
    output: {
      filename: 'voice-satellite-card.js',
      path: wwwDir,
    },
    optimization: {
      minimize: true,
    },
  };
};
