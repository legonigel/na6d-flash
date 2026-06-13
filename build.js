const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

// Helper to recursively copy directories (ensures compatibility across OS versions)
function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function runBuild() {
  console.log('Building and minifying assets...');

  // 1. Clean dist/ contents without deleting the folder itself (prevents Windows EPERM watch issues)
  if (fs.existsSync('dist')) {
    const files = fs.readdirSync('dist');
    for (const file of files) {
      fs.rmSync(path.join('dist', file), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync('dist', { recursive: true });
  }

  // 2. Copy static files
  const staticFiles = ['index.html', 'favicon.png', 'logo.svg'];
  staticFiles.forEach((file) => {
    const srcPath = path.join('src', file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join('dist', file));
    }
  });

  const firmwareDir = path.join('src', 'firmware');
  if (fs.existsSync(firmwareDir)) {
    copyRecursiveSync(firmwareDir, path.join('dist', 'firmware'));
  }

  // 3. Minify JS and CSS using esbuild (without bundling to preserve individual global scopes)
  await esbuild.build({
    entryPoints: ['src/app.js', 'src/dfu.js', 'src/dfuse.js', 'src/FileSaver.js', 'src/index.css'],
    bundle: false,
    minify: true,
    outdir: 'dist',
    logLevel: 'info',
  });

  console.log('Build completed successfully!');
}

runBuild().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
