# GitHub Pages Deployment Instructions

This guide will help you deploy the static version of your Nitrate-Cancer Explorer to GitHub Pages.

## Prerequisites

- A GitHub account
- Git installed on your computer
- Your project files ready to push

## Step 1: Create a GitHub Repository

1. Go to [GitHub](https://github.com) and sign in
2. Click the "+" icon in the top right and select "New repository"
3. Name your repository (e.g., `nitrate-cancer-explorer`)
4. Make it **Public** (required for free GitHub Pages)
5. Do NOT initialize with README (you already have files)
6. Click "Create repository"

## Step 2: Push Your Code to GitHub

Open a terminal in your project directory and run:

```bash
# Initialize git repository (if not already done)
git init

# Add all files
git add .

# Create your first commit
git commit -m "Initial commit with static GitHub Pages version"

# Add your GitHub repository as remote (replace with your URL)
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git

# Push to GitHub
git branch -M main
git push -u origin main
```

## Step 3: Enable GitHub Pages

1. Go to your repository on GitHub
2. Click on "Settings" (top right)
3. Scroll down and click on "Pages" in the left sidebar
4. Under "Source", select:
   - **Branch**: `main`
   - **Folder**: `/docs`
5. Click "Save"

## Step 4: Wait for Deployment

GitHub will automatically build and deploy your site. This usually takes 1-2 minutes.

You'll see a message like:
```
Your site is live at https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/
```

## Step 5: Update Your README

Update the README.md files to include your actual GitHub Pages URL:

1. Edit `docs/README.md`
2. Replace `[GitHub Pages URL will be here after deployment]` with your actual URL
3. Edit `docs/index.html` if you want to update the repository link in the About modal

```bash
git add docs/README.md docs/index.html
git commit -m "Update README with live demo URL"
git push
```

## File Structure

Your repository should look like this:

```
your-repo/
├── docs/                          # GitHub Pages serves from this folder
│   ├── index.html                 # Main HTML file
│   ├── style.css                  # Styles
│   ├── ui.js                      # JavaScript (modified for static)
│   ├── outputs/                   # Pre-computed data
│   │   ├── bounds.json
│   │   ├── wells.geojson
│   │   ├── tracts_k*.geojson
│   │   ├── nitrate_k*.png
│   │   ├── tract_table_k*.csv
│   │   └── sensitivity_*.csv
│   ├── .nojekyll                  # Tells GitHub Pages not to use Jekyll
│   └── README.md                  # Documentation for the demo
├── app.py                         # Your original Flask app (not deployed)
├── static/                        # Your original static files (not deployed)
├── outputs/                       # Your original outputs (not deployed)
└── GITHUB_PAGES_SETUP.md         # This file
```

## Troubleshooting

### Site not loading?

1. Check that GitHub Pages is enabled in Settings > Pages
2. Make sure you selected `/docs` folder, not `/` (root)
3. Wait a few minutes - deployment can take time
4. Check the Actions tab for build errors

### 404 errors on data files?

1. Make sure all file paths in `ui.js` are relative (e.g., `outputs/file.json` not `/outputs/file.json`)
2. Check that files exist in `docs/outputs/` folder
3. File names are case-sensitive!

### Map not displaying?

1. Open browser Developer Console (F12) to check for errors
2. Verify Leaflet CDN links are working
3. Check that `bounds.json` exists and is valid JSON

## Updating Your Site

When you want to update your GitHub Pages site:

```bash
# Make changes to files in docs/ folder
# Then commit and push:

git add docs/
git commit -m "Update site with new data"
git push
```

GitHub will automatically redeploy your site within 1-2 minutes.

## Custom Domain (Optional)

If you want to use a custom domain (e.g., `nitrate.example.com`):

1. Go to Settings > Pages
2. Enter your custom domain under "Custom domain"
3. Follow GitHub's instructions to configure DNS

## Next Steps

After deployment:

1. Share your GitHub Pages URL in your portfolio
2. Add the URL to your resume or CV
3. Include it in your project documentation
4. Share it with colleagues or on social media

## Cost

GitHub Pages is **completely free** for public repositories!

## Support

- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [GitHub Pages Troubleshooting](https://docs.github.com/en/pages/getting-started-with-github-pages/troubleshooting-404-errors-for-github-pages-sites)
