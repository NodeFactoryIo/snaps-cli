const stripComments = require("@nodefactory/strip-comments");

const fs = require('fs');
const browserify = require('browserify');

const { logError } = require('./utils');

module.exports = {
  bundle: bundle,
}

/**
 * Builds a Snap bundle JSON file from its JavaScript source.
 *
 * @param {string} src - The source file path
 * @param {string} dest - The destination file path
 * @param {object} argv - argv from Yargs
 * @param {boolean} argv.sourceMaps - Whether to output sourcemaps
 * @param {boolean} argv.stripComments - Whether to remove comments from code
 */
function bundle(src, dest, argv) {

  return new Promise((resolve, _reject) => {

    const bundleStream = createBundleStream(dest)

    browserify(src, { debug: argv.sourceMaps })

    // TODO: Just give up on babel, which we may not even need?
    // This creates globals that SES doesn't like
    // .transform('babelify', {
    //   presets: ['@babel/preset-env'],
    // })
        .bundle((err, bundle) => {

          if (err) writeError('Build error:', err)

          // TODO: minification, probably?
          // const { error, code } = terser.minify(bundle.toString())
          // if (error) {
          //   writeError('Build error:', error.message, error, dest)
          // }
          // closeBundleStream(bundleStream, code.toString())

          closeBundleStream(bundleStream, bundle ? bundle.toString() : null, {stripComments: argv.stripComments})
              .then(() => {
                if (bundle) {
                  console.log(`Build success: '${src}' bundled as '${dest}'!`)
                }
                resolve(true)
              })
              .catch((err) => writeError('Write error:', err.message, err, dest))
        })
  })
}

/**
 * Opens a stream to write the destination file path.
 *
 * @param {string} dest - The output file path
 * @returns {object} - The stream
 */
function createBundleStream (dest) {
  const stream = fs.createWriteStream(dest, {
    autoClose: false,
    encoding: 'utf8',
  })
  stream.on('error', err => {
    writeError('Write error:', err.message, err, dest)
  })
  return stream
}

/**
 * Postprocesses the bundle string and closes the write stream.
 *
 * @param {object} stream - The write stream
 * @param {string} bundleString - The bundle string
 * @param {object} options - post process options
 * @param {boolean} options.stripComments
 */
async function closeBundleStream (stream, bundleString, options) {
  stream.end(postProcess(bundleString, options), (err) => {
    if (err) throw err
  })
}

/**
 * Postprocesses a JavaScript bundle string such that it can be evaluated in SES.
 * Currently:
 * - converts certain dot notation to string notation (for indexing)
 * - makes all direct calls to eval indirect
 * - wraps original bundle in anonymous function
 * - handles certain Babel-related edge cases
 *
 * @param {string} bundleString - The bundle string
 * @param {object} options - post process options
 * @param {boolean} options.stripComments
 * @returns {string} - The postprocessed bundle string
 */
function postProcess (bundleString, options) {

  if (typeof bundleString !== 'string') {
    return null
  }

  bundleString = bundleString.trim()

  if (options.stripComments) {
    bundleString = stripComments(bundleString)
  }

  // .import( => ["import"](
  bundleString = bundleString.replace(/\.import\(/g, '["import"](')

  // stuff.eval(otherStuff) => (1, stuff.eval)(otherStuff)
  bundleString = bundleString.replace(
      /((?:\b[\w\d]*[\]\)]?\.)+eval)(\([^)]*\))/g,
      '(1, $1)$2'
  )

  // if we don't do the above, the below causes syntax errors if it encounters
  // things of the form: "something.eval(stuff)"
  // eval(stuff) => (1, eval)(stuff)
  bundleString = bundleString.replace(/(\b)(eval)(\([^)]*\))/g, '$1(1, $2)$3')

  // SES interprets syntactically valid JavaScript '<!--' and '-->' as illegal
  // HTML comment syntax.
  // '<!--' => '<! --' && '-->' => '-- >'
  bundleString = bundleString.replace(/<!--/g, '< !--')
  bundleString = bundleString.replace(/-->/g, '-- >')

  // Browserify provides the Buffer global as an argument to modules that use
  // it, but this does not work in SES. Since we pass in Buffer as an endowment,
  // we can simply remove the argument.
  bundleString = bundleString.replace(/^\(function \(Buffer\)\{$/gm, '(function (){')

  if (bundleString.length === 0) throw new Error(
      `Bundled code is empty after postprocessing.`
  )

  // wrap bundle conents in anonymous function
  if (bundleString.endsWith(';')) bundleString = bundleString.slice(0, -1)
  if (bundleString.startsWith('(') && bundleString.endsWith(')')) {
    bundleString = '() => ' + bundleString
  } else {
    bundleString = '() => (\n' + bundleString + '\n)'
  }

  // handle some cases by declaring missing globals
  // Babel regeneratorRuntime
  if (bundleString.indexOf('regeneratorRuntime') !== -1) {
    bundleString = 'var regeneratorRuntime;\n' + bundleString
  }

  bundleString = bundleString.replace(/self/g, "window");

  // filecoin specific fix
  bundleString = bundleString.replace(/stdlib./g, '');

  // polkadot specific fix, remove setImmediate
  bundleString = bundleString.replace("setImmediate(() => resultCb(result))", "resultCb(result)");

  return bundleString
}

/**
 * Logs an error, attempts to unlink the destination file, and exits.
 *
 * @param {string} prefix - The message prefix.
 * @param {string} msg - The error message
 * @param {Error} err - The original error
 * @param {string} destFilePath - The output file path
 */
function writeError (prefix, msg, err, destFilePath) {

  if (!prefix.endsWith(' ')) prefix += ' '

  logError(prefix + msg, err)
  try {
    if (destFilePath) fs.unlinkSync(destFilePath)
  } catch (_err) {}

  // unless the watcher is active, exit
  if (!snaps.isWatching) {
    process.exit(1)
  }
}
