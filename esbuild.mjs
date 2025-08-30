import path from 'node:path';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const outputRootIndex = process.argv.indexOf('--outputRoot');
const outputRoot = outputRootIndex !== -1 ? process.argv[outputRootIndex + 1] : undefined;

async function main() {
  const outFile = outputRoot
    ? path.join(outputRoot, 'out/bundle.js')
    : path.join(import.meta.dirname, 'out/bundle.js');

  const ctx = await esbuild.context({
    entryPoints: [path.join(import.meta.dirname, 'src/extension.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: outFile,
    sourcemap: true,
    sourcesContent: false,
    external: [
      // Always external in VS Code extensions
      'vscode',
      // Upstream marks this as external in package.json scripts
      '@aws-sdk/client-s3',
    ],
    logLevel: 'warning',
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

// Minimal problem matcher for nice watch output in gulp
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        if (location)
          console.error(`> ${location.file}:${location.line}:${location.column}: error: ${text}`);
        else
          console.error(`> unknown: error: ${text}`);
      });
      console.error('[watch] build finished');
    });
  }
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});

