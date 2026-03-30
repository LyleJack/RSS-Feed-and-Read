# RoyalRoadReaderRewrite — APK Build Setup

## Files in this repo

```
App.js                          Main application (single file)
package.json                    Dependencies
app.json                        Expo / Android config
eas.json                        EAS Build profiles
babel.config.js                 Babel config
google-services.json            Firebase config (replace with real one)
assets/
  icon.png                      App icon 1024x1024 (you must provide)
  adaptive-icon.png             Android adaptive icon foreground 1024x1024
  notification-icon.png         Notification icon 96x96 white on transparent
.github/workflows/build.yml     GitHub Actions CI build
```

---

## One-time setup (do this before your first build)

### 1. Create an Expo account and project

1. Go to https://expo.dev and create a free account
2. Create a new project called `RoyalRoadReaderRewrite`
3. Copy the **Project ID** from the project dashboard

### 2. Put the Project ID in app.json

Open `app.json` and replace `YOUR_EAS_PROJECT_ID` with your actual project ID:

```json
"extra": {
  "eas": {
    "projectId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

### 3. Get your Expo token for GitHub Actions

1. Go to https://expo.dev/accounts/[your-username]/settings/access-tokens
2. Create a new token, call it `GITHUB_ACTIONS`
3. Copy the token value

### 4. Add the token to GitHub Secrets

1. Go to your GitHub repo → Settings → Secrets and variables → Actions
2. Click **New repository secret**
3. Name: `EXPO_TOKEN`
4. Value: paste the token from step 3

### 5. Add app icons

Replace the placeholder files in `assets/` with real PNG files:

- `assets/icon.png` — 1024×1024 px, your app icon
- `assets/adaptive-icon.png` — 1024×1024 px, foreground for Android adaptive icon
- `assets/notification-icon.png` — 96×96 px, white icon on transparent background

You can use any image editor. A simple coloured circle with "F+" text works fine.

### 6. Firebase / Push Notifications (optional but recommended)

For push notifications to work on-device:

1. Go to https://console.firebase.google.com
2. Create a project, add an Android app with package name `com.RoyalRoadReaderRewrite.app`
3. Download `google-services.json` and replace the placeholder in this repo
4. No code changes needed — `expo-notifications` handles the rest

If you skip this, the app builds and runs fine but notifications won't fire.

---

## Building

### Automatic (GitHub Actions)

Push to the `main` branch — the workflow triggers automatically.
Or go to **Actions → Build RoyalRoadReaderRewrite APK → Run workflow** for a manual trigger.

The build runs on Expo's cloud servers (EAS Build), not on GitHub's runners.
GitHub Actions just triggers it and reports the result.

**Build time: ~10–15 minutes**

When done, EAS emails you and you can download the APK from:
https://expo.dev/accounts/[your-username]/projects/RoyalRoadReaderRewrite/builds

### Manual (local)

```bash
npm install
npm install -g eas-cli
eas login
eas build --platform android --profile preview --non-interactive
```

---

## What changes in the APK vs Expo Go

| Feature | Expo Go | APK |
|---|---|---|
| RSS direct fetch | ❌ needs proxy | ✅ direct, no CORS |
| Background refresh | ❌ not supported | ✅ runs every ~15 min |
| Push notifications | ❌ not supported | ✅ works |
| Navigation bar colour | ⚠️ partial | ✅ fully controlled |
| App icon | Expo Go icon | ✅ your icon |

The RSS reliability issue you've experienced is almost entirely caused by the
proxy requirement in Expo Go. In the APK, `fetch('https://royalroad.com/...')`
goes directly to the server with no middleman.

---

## Updating the app

1. Edit `App.js`
2. Bump `versionCode` in `app.json` (e.g. 1 → 2)
3. Push to `main` — GitHub Actions builds a new APK automatically
4. Download and install over the existing app (Android allows this for debug/preview builds)
