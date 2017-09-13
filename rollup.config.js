import commonjs from "rollup-plugin-commonjs";
import nodeResolve from "rollup-plugin-node-resolve";

export default {
  entry: "./test/repeat.spec.js",
  dest: "./test/test.bundle.js",
  format: "iife",
  name: "tests",
  plugins: [
    nodeResolve({
      jsnext: true,
      main: true
    }),

    commonjs({
      include: "node_modules/**", // Default: undefined

      // if true then uses of `global` won't be dealt with by this plugin
      // ignoreGlobal: false, // Default: false

      // if false then skip sourceMap generation for CommonJS modules
      sourceMap: false, // Default: true

      // explicitly specify unresolvable named exports
      // (see below for more details)
      namedExports: { "./module.js": ["foo", "bar"] } // Default: undefined
    })
  ]
};
