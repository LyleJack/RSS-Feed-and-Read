# royalroadreader — build & deploy Makefile
# Usage:
#   make royalroadreader     — full pipeline: validate → commit → push → trigger build
#   make setup               — first-time repo + secrets setup guide
#   make build               — just trigger the GitHub Action (no commit)
#   make version             — bump versionCode in app.json

# ── Config ────────────────────────────────────────────────────────────────────
REPO        ?= $(shell git remote get-url main 2>/dev/null | sed 's/.*github.com[:/]//' | sed 's/\.git//')
BRANCH      ?= main
MSG         ?= "Update app"
GH          := gh                  # GitHub CLI — brew install gh / apt install gh

# ── Default target ────────────────────────────────────────────────────────────
.PHONY: royalroadreader
royalroadreader: _check_tools _validate _bump_version _commit _push _trigger
	@echo ""
	@echo "✅  Done. Build triggered on GitHub Actions."
	@echo "    Watch it at: https://github.com/$(REPO)/actions"
	@echo "    Download APK from the workflow run → Artifacts when complete."

# ── Individual steps ─────────────────────────────────────────────────────────
.PHONY: _check_tools
_check_tools:
	@echo "── Checking required tools ──"
	@command -v node   >/dev/null 2>&1 || (echo "❌  node not found. Install from nodejs.org"; exit 1)
	@command -v git    >/dev/null 2>&1 || (echo "❌  git not found"; exit 1)
	@command -v $(GH)  >/dev/null 2>&1 || (echo "❌  GitHub CLI not found. Install: https://cli.github.com"; exit 1)
	@$(GH) auth status >/dev/null 2>&1 || (echo "❌  Not logged into GitHub CLI. Run: gh auth login"; exit 1)
	@echo "   ✓ All tools present"

.PHONY: _validate
_validate:
	@echo "── Validating App.js ──"
	@node -e "\
		const src = require('fs').readFileSync('App.js', 'utf8');\
		const issues = [];\
		if (!src.includes('export default function App')) issues.push('Missing App export');\
		if ((src.match(/\`/g)||[]).length % 2 !== 0) issues.push('Odd number of backticks');\
		if (issues.length) { console.error('Validation failed:', issues.join(', ')); process.exit(1); }\
	" 2>&1
	@echo "   ✓ App.js looks valid"

.PHONY: _bump_version
_bump_version:
	@echo "── Bumping versionCode ──"
	@printf '%s\n' \
		"import json" \
		"d = json.load(open('app.json'))" \
		"old = d['expo']['android']['versionCode']" \
		"d['expo']['android']['versionCode'] = old + 1" \
		"open('app.json','w').write(json.dumps(d, indent=2))" \
		"print(f'   versionCode {old} → {old+1}')" \
		> /tmp/_bump_version.py
	@python3 /tmp/_bump_version.py
	@rm -f /tmp/_bump_version.py
	@echo "   ✓ versionCode bumped"

.PHONY: _commit
_commit:
	@echo "── Committing changes ──"
	@git add App.js app.json package.json app.json eas.json babel.config.js \
	         .github/workflows/build.yml google-services.json assets/ 2>/dev/null || true
	@git diff --cached --quiet && echo "   (nothing new to commit)" || \
	  git commit -m $(MSG)
	@echo "   ✓ Committed"

.PHONY: _push
_push:
	@echo "── Pushing to $(BRANCH) ──"
	@git push main $(BRANCH)
	@echo "   ✓ Pushed"

.PHONY: _trigger
_trigger:
	@echo "── Triggering GitHub Action ──"
	@$(GH) workflow run build.yml --repo $(REPO) --ref $(BRANCH) || \
	  echo "   (push already triggers the workflow — manual trigger skipped)"
	@echo "   ✓ Build started"

# ── Utility targets ───────────────────────────────────────────────────────────
.PHONY: build
build: _check_tools _trigger

.PHONY: version
version: _bump_version
	@echo "   app.json updated. Commit and push manually or run: make royalroadreader"

.PHONY: status
status:
	@echo "── Latest build status ──"
	@$(GH) run list --repo $(REPO) --workflow build.yml --limit 5

.PHONY: download
download:
	@echo "── Downloading latest APK ──"
	@RUNID=$$($(GH) run list --repo $(REPO) --workflow build.yml --limit 1 --json databaseId -q '.[0].databaseId'); \
	 $(GH) run download $$RUNID --repo $(REPO) --name royalroadreader-apk --dir ./apk-output && \
	 echo "✅  APK saved to ./apk-output/"

.PHONY: setup
setup:
	@echo ""
	@echo "════════════════════════════════════════════════════════"
	@echo "  royalroadreader — First-time setup"
	@echo "════════════════════════════════════════════════════════"
	@echo ""
	@echo "1. Install GitHub CLI:"
	@echo "   macOS:   brew install gh"
	@echo "   Linux:   sudo apt install gh"
	@echo "   Windows: winget install GitHub.cli"
	@echo ""
	@echo "2. Log in:"
	@echo "   gh auth login"
	@echo ""
	@echo "3. Create a GitHub repo and push this folder:"
	@echo "   git init"
	@echo "   git remote add origin https://github.com/YOUR_USERNAME/RSS-Feed-and-Read.git"
	@echo "   git add ."
	@echo "   git commit -m 'Initial commit'"
	@echo "   git push -u origin main"
	@echo ""
	@echo "4. Add secrets for APK signing (optional but needed for installable APK):"
	@echo ""
	@echo "   Generate a keystore (run once, keep the file safe):"
	@echo "   keytool -genkeypair -v -keystore royalroadreader.jks -alias royalroadreader \\"
	@echo "     -keyalg RSA -keysize 2048 -validity 10000 \\"
	@echo "     -storepass YOUR_STORE_PASSWORD -keypass YOUR_KEY_PASSWORD \\"
	@echo '     -dname "CN=royalroadreader,O=Personal,C=US"'
	@echo ""
	@echo "   Convert to base64:"
	@echo "   base64 -w 0 royalroadreader.jks > royalroadreader.jks.b64"
	@echo ""
	@echo "   Add GitHub secrets:"
	@echo "   gh secret set KEYSTORE_BASE64  < royalroadreader.jks.b64"
	@echo "   gh secret set KEY_ALIAS        --body 'royalroadreader'"
	@echo "   gh secret set KEY_PASSWORD     --body 'YOUR_KEY_PASSWORD'"
	@echo "   gh secret set STORE_PASSWORD   --body 'YOUR_STORE_PASSWORD'"
	@echo ""
	@echo "5. Add app icons to assets/:"
	@echo "   assets/icon.png               1024x1024"
	@echo "   assets/adaptive-icon.png      1024x1024"
	@echo "   assets/notification-icon.png  96x96 white on transparent"
	@echo ""
	@echo "6. (Optional) Firebase for push notifications:"
	@echo "   - console.firebase.google.com → new project"
	@echo "   - Add Android app, package: com.royalroadreader.app"
	@echo "   - Download google-services.json → replace placeholder in repo"
	@echo "   - OR remove googleServicesFile from app.json to skip"
	@echo ""
	@echo "7. After setup, just run:  make royalroadreader"
	@echo ""
