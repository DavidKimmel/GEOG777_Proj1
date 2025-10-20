# Quick Start: Deploy to GitHub Pages in 5 Minutes

## Prerequisites
- GitHub account (create free at [github.com](https://github.com))
- Git installed on your computer

## Steps

### 1. Create GitHub Repository (2 minutes)

1. Go to https://github.com/new
2. Repository name: `nitrate-cancer-explorer` (or your choice)
3. Make it **Public**
4. Do NOT check "Add README"
5. Click "Create repository"

### 2. Push Your Code (2 minutes)

Open terminal in your project folder and run these commands one by one:

```bash
# Initialize git (if not already done)
git init

# Add all files
git add .

# Create first commit
git commit -m "Add static GitHub Pages version"

# Connect to GitHub (REPLACE with your actual URL from step 1)
git remote add origin https://github.com/YOUR_USERNAME/nitrate-cancer-explorer.git

# Push to GitHub
git branch -M main
git push -u origin main
```

### 3. Enable GitHub Pages (1 minute)

1. Go to your repository on GitHub
2. Click **Settings** (top menu)
3. Click **Pages** (left sidebar)
4. Under "Source":
   - Branch: **main**
   - Folder: **/docs**
5. Click **Save**

### 4. Wait & Visit (1-2 minutes)

GitHub will show: "Your site is live at https://YOUR_USERNAME.github.io/nitrate-cancer-explorer/"

Click the link or wait 1-2 minutes for deployment to complete.

## Done!

Your interactive map is now live and shareable!

### Test It

Visit your site and:
1. Select a k-value from the dropdown
2. Click "Load Data"
3. Explore the interactive map
4. Click "Load Sensitivity" to see sensitivity analysis

### Share It

Add to your:
- Resume/CV
- LinkedIn profile
- Portfolio website
- Class presentations

## Troubleshooting

**Site shows 404?**
- Wait 2-3 minutes, deployment takes time
- Check Settings → Pages shows green checkmark

**Map not loading?**
- Open browser console (F12) and check for errors
- Verify you selected `/docs` folder in GitHub Pages settings

**Need help?**
- See `GITHUB_PAGES_SETUP.md` for detailed instructions
- See `STATIC_VERSION_SUMMARY.md` for technical details

## Your Live URL Format

```
https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/
```

Example:
```
https://dkimmel.github.io/nitrate-cancer-explorer/
```

## Next Update

To update your site after making changes:

```bash
git add docs/
git commit -m "Update data"
git push
```

GitHub automatically redeploys within 1-2 minutes!
