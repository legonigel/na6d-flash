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

  // 2. Retrieve git commit hash
  let commitHash = 'dev';
  try {
    const { execSync } = require('child_process');
    commitHash = execSync('git rev-parse --short HEAD').toString().trim();
  } catch (e) {
    console.warn('Could not get git commit hash, defaulting to "dev":', e.message);
  }

  // 3. Assemble HTML pages from layouts and templates
  const layoutPath = path.join('src', 'templates', 'layout.html');
  const pagesDir = path.join('src', 'pages');

  if (fs.existsSync(layoutPath) && fs.existsSync(pagesDir)) {
    const layoutTemplate = fs.readFileSync(layoutPath, 'utf8');
    const pageFiles = fs.readdirSync(pagesDir).filter((file) => file.endsWith('.html'));

    pageFiles.forEach((file) => {
      const pagePath = path.join(pagesDir, file);
      const pageRawContent = fs.readFileSync(pagePath, 'utf8');

      // Parse frontmatter and templates
      let meta = {};
      let body = pageRawContent;
      const frontmatterMatch = pageRawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (frontmatterMatch) {
        const yamlStr = frontmatterMatch[1];
        body = frontmatterMatch[2];
        yamlStr.split(/\r?\n/).forEach((line) => {
          const parts = line.split(':');
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const val = parts
              .slice(1)
              .join(':')
              .trim()
              .replace(/^['"]|['"]$/g, '');
            meta[key] = val;
          }
        });
      }

      const headMatch = body.match(/<template\s+id="head">([\s\S]*?)<\/template>/i);
      const contentMatch = body.match(/<template\s+id="content">([\s\S]*?)<\/template>/i);

      const head = headMatch ? headMatch[1].trim() : '';
      const pageContent = contentMatch ? contentMatch[1].trim() : '';

      // Assemble page
      let pageHtml = layoutTemplate;
      pageHtml = pageHtml.replace(/\{\{title\}\}/g, meta.title || 'NA6D');
      pageHtml = pageHtml.replace(/\{\{description\}\}/g, meta.description || '');
      pageHtml = pageHtml.replace(/\{\{canonical\}\}/g, meta.canonical || '');
      pageHtml = pageHtml.replace(/\{\{head\}\}/g, head || '');
      pageHtml = pageHtml.replace(/\{\{content\}\}/g, pageContent || '');

      // Replace version commit hash
      pageHtml = pageHtml.replace(/%%COMMIT_HASH%%/g, commitHash);

      // Write to dist/
      fs.writeFileSync(path.join('dist', file), pageHtml, 'utf8');
      console.log(`Assembled page: ${file}`);
    });
  } else {
    console.warn('Layout template or pages directory not found, skipping HTML assembly.');
  }

  // Copy other static assets
  const staticFiles = [
    'favicon.png',
    'logo.svg',
    'favicon-96x96.png',
    'favicon.svg',
    'favicon.ico',
    'apple-touch-icon.png',
    'site.webmanifest',
    'web-app-manifest-192x192.png',
    'web-app-manifest-512x512.png',
  ];
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

  const isDev =
    process.env.WRANGLER_COMMAND === 'dev' ||
    process.argv.includes('--dev') ||
    process.env.NODE_ENV === 'development';
  if (isDev) {
    console.log('Running in development mode: Minification disabled, source maps enabled.');
  }

  // 3. Minify JS and CSS using esbuild (without bundling to preserve individual global scopes)
  await esbuild.build({
    entryPoints: ['src/app.js', 'src/dfu.js', 'src/dfuse.js', 'src/FileSaver.js', 'src/index.css'],
    bundle: false,
    minify: !isDev,
    sourcemap: true,
    outdir: 'dist',
    logLevel: 'info',
  });

  // 4. Generate sitemap.xml and robots.txt
  generateSitemapAndRobots();

  // 5. PostHog Source Map Injection and Upload (only during wrangler deploy)
  if (process.env.WRANGLER_COMMAND === 'deploy') {
    // Try to load .env variables if they exist
    if (fs.existsSync('.env')) {
      const envContent = fs.readFileSync('.env', 'utf8');
      envContent.split('\n').forEach((line) => {
        const parts = line.trim().split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts
            .slice(1)
            .join('=')
            .trim()
            .replace(/^['"]|['"]$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      });
    }

    const apiKey = process.env.POSTHOG_CLI_API_KEY;
    const projectId = process.env.POSTHOG_CLI_PROJECT_ID;

    if (apiKey && projectId) {
      try {
        const { execSync } = require('child_process');
        console.log('Injecting PostHog release metadata...');
        execSync('npx @posthog/cli sourcemap inject --directory dist', { stdio: 'inherit' });

        console.log('Uploading source maps to PostHog...');
        execSync(
          `npx @posthog/cli sourcemap upload --directory dist --release-name na6d-flash --release-version ${commitHash}`,
          { stdio: 'inherit' }
        );
      } catch (err) {
        console.error('PostHog source map integration failed:', err.message);
      }
    } else {
      console.log(
        'PostHog source maps upload skipped: POSTHOG_CLI_API_KEY or POSTHOG_CLI_PROJECT_ID not set in build environment.'
      );
    }
  }

  console.log('Build completed successfully!');
}

function generateSitemapAndRobots() {
  const baseUrl = 'https://flash.na6d.com';
  const distDir = 'dist';

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Find all .html files in dist/
  const files = fs.readdirSync(distDir);
  const htmlFiles = files.filter((file) => file.endsWith('.html'));

  let sitemapEntries = '';

  htmlFiles.forEach((file) => {
    const filePath = path.join(distDir, file);
    const stats = fs.statSync(filePath);
    const lastmod = stats.mtime.toISOString().split('T')[0];

    // Map filename to URL path. index.html -> /, other.html -> /other.html (or worker route)
    let urlPath = '/' + file;
    if (file === 'index.html') {
      urlPath = '/';
    }

    const url = `${baseUrl}${urlPath}`;
    const priority = file === 'index.html' ? '1.0' : '0.8';
    const changefreq = 'monthly';

    sitemapEntries += `  <url>
    <loc>${url}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>\n`;
  });

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries}</urlset>`;

  fs.writeFileSync(path.join(distDir, 'sitemap.xml'), sitemapXml.trim() + '\n');
  console.log('Generated sitemap.xml');

  const robotsTxt = `User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
`;

  fs.writeFileSync(path.join(distDir, 'robots.txt'), robotsTxt);
  console.log('Generated robots.txt');
}

runBuild().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
