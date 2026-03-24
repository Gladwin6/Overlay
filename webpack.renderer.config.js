const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: 'development',
  target: 'electron-renderer',
  devtool: 'source-map',

  entry: {
    overlay: './src/renderer/overlay/index.tsx',
    setup: './src/renderer/setup/index.tsx',
    splash: './src/renderer/splash/index.tsx',
  },

  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: '[name]/index.js',
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      shared: path.resolve(__dirname, 'src/shared'),
      three: path.resolve(__dirname, 'node_modules/three'),
    },
  },

  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json',
          },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },

  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer/overlay/index.html',
      filename: 'overlay/index.html',
      chunks: ['overlay'],
    }),
    new HtmlWebpackPlugin({
      template: './src/renderer/setup/index.html',
      filename: 'setup/index.html',
      chunks: ['setup'],
    }),
    new HtmlWebpackPlugin({
      template: './src/renderer/splash/index.html',
      filename: 'splash/index.html',
      chunks: ['splash'],
    }),
  ],

  externals: {
    electron: 'commonjs electron',
  },
};
