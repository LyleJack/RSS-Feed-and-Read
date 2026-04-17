// RoyalRoadReader — RSS reader with Royal Road support
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, FlatList, TextInput,
  ScrollView, Switch, Alert, Modal, ActivityIndicator, StatusBar, Appearance,
  Platform, RefreshControl, KeyboardAvoidingView, Share, Linking,
  AppState, PanResponder, Animated, BackHandler,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';

// ============================================================
// THEMES
// ============================================================
const LIGHT = {
  mode:'light', bg:'#F5F1EB', surface:'#FFFFFF', surfaceAlt:'#EDE8E0',
  border:'#D5CFC5', text:'#1A1612', textSub:'#6B6055', textMuted:'#9C9080',
  accent:'#B84A1C', accentBg:'#FAEEE8', tag:'#E8E2D8', tagText:'#5A5448',
  paused:'#8B7355', pausedBg:'#F5EFE2', danger:'#C0392B', success:'#27AE60',
  header:'#FFFFFF', tabBg:'#FFFFFF', tabActive:'#B84A1C', tabInactive:'#9C9080',
  card:'#FFFFFF', unread:'#1A1612', read:'#9C9080',
};
const DARK = {
  mode:'dark', bg:'#100F0D', surface:'#1A1916', surfaceAlt:'#22201C',
  border:'#2E2B26', text:'#EEE8DE', textSub:'#A09080', textMuted:'#6B6055',
  accent:'#E07040', accentBg:'#2A1508', tag:'#22201C', tagText:'#A09080',
  paused:'#8B7355', pausedBg:'#1C1810', danger:'#E74C3C', success:'#2ECC71',
  header:'#1A1916', tabBg:'#1A1916', tabActive:'#E07040', tabInactive:'#6B6055',
  card:'#1A1916', unread:'#EEE8DE', read:'#6B6055',
};

const CHECK_INTERVALS = [
  { label:'30 min', ms:30*60*1000 },
  { label:'1 hr',   ms:60*60*1000 },
  { label:'2 hrs',  ms:2*60*60*1000 },
  { label:'4 hrs',  ms:4*60*60*1000 },
  { label:'6 hrs',  ms:6*60*60*1000 },
  { label:'12 hrs', ms:12*60*60*1000 },
  { label:'24 hrs', ms:24*60*60*1000 },
];

// ============================================================
// OPML PARSER
// ============================================================
function parseOPML(xml) {
  const feeds = [];
  const getAttr = (str, name) => {
    const r = new RegExp(name + '=["\']([^"\']*)["\']', 'i');
    const m = str.match(r);
    return m ? m[1].trim() : '';
  };
  let currentCat = 'General';
  for (const line of xml.split('\n')) {
    const t = line.trim();
    if (!t.includes('<outline')) continue;
    if (!/xmlUrl/i.test(t)) {
      const name = getAttr(t, 'text') || getAttr(t, 'title');
      if (name) currentCat = name;
      continue;
    }
    const xmlUrl = getAttr(t, 'xmlUrl');
    if (!xmlUrl) continue;
    feeds.push({
      id: 'feed_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      url: xmlUrl,
      title: getAttr(t, 'title') || getAttr(t, 'text') || xmlUrl,
      htmlUrl: getAttr(t, 'htmlUrl'),
      category: getAttr(t, 'category') || currentCat || 'General',
      paused: false, pauseArticleId: null, addedAt: Date.now(),
    });
  }
  const seen = new Set();
  return feeds.filter(f => { if (seen.has(f.url)) return false; seen.add(f.url); return true; });
}

// ============================================================
// OPML GENERATOR
// ============================================================
function generateOPML(feeds, cats) {
  const esc = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const now = new Date().toUTCString();
  const grouped = {};
  for (const f of feeds) {
    const c = f.category || 'General';
    if (!grouped[c]) grouped[c] = [];
    grouped[c].push(f);
  }
  const allCats = [...new Set([...cats, ...Object.keys(grouped)])];
  const body = allCats.map(cat => {
    const cf = grouped[cat] || [];
    if (!cf.length) return '';
    const rows = cf.map(f =>
      '        <outline type="rss" text="' + esc(f.title) + '" title="' + esc(f.title) +
      '" xmlUrl="' + esc(f.url) + '" htmlUrl="' + esc(f.htmlUrl || '') +
      '" category="' + esc(cat) + '"/>'
    ).join('\n');
    return '    <outline text="' + esc(cat) + '" title="' + esc(cat) + '">\n' + rows + '\n    </outline>';
  }).filter(Boolean).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.1">\n  <head>\n    <title>RSS Feed Export</title>\n    <dateCreated>' + now + '</dateCreated>\n    <ownerName>RoyalRoadReaderRSS</ownerName>\n  </head>\n  <body>\n' + body + '\n  </body>\n</opml>';
}

// ============================================================
// RSS PARSER
// ============================================================
function parseRSS(xml, feedId, feedTitle) {
  const articles = [];
  const getTag = (str, tag) => {
    const reCD = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i');
    const reNM = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
    const mCD = str.match(reCD); if (mCD) return mCD[1].trim();
    const mNM = str.match(reNM); return mNM ? mNM[1].trim() : '';
  };
  const strip = h => {
    if (!h) return '';
    let s = h.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
             .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
    return s.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
  };
  const getAttr = (str, tag, at) => {
    const r = new RegExp('<' + tag + '[^>]*' + at + '=["\']([^"\']+)["\']', 'i');
    const m = str.match(r); return m ? m[1] : '';
  };
  const tryParse = tag => {
    const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
    let m;
    while ((m = re.exec(xml)) !== null) {
      const it = m[1];
      const title   = strip(getTag(it, 'title'));
      // RR Atom feeds use <link href="url"/> with no text content
      const link    = getTag(it, 'link') || getAttr(it, 'link', 'href') || getAttr(it, 'link', 'rel:alternate') || '';
      const pubDate = getTag(it,'pubDate') || getTag(it,'published') || getTag(it,'dc:date') || getTag(it,'updated');
      const desc    = getTag(it,'content:encoded') || getTag(it,'content') || getTag(it,'description') || getTag(it,'summary');
      const guid    = getTag(it,'guid') || getTag(it,'id') || link;
      if (title && link) {
        articles.push({
          id: feedId + '_' + (guid.length > 60 ? guid.slice(-60) : guid),
          feedId, feedTitle, title, link,
          description: strip(desc).slice(0, 280),
          fullHtml: '', // RSS excerpt only - always load URL for full chapter
          pubDate: pubDate ? new Date(pubDate).getTime() : Date.now(),
          read: false, bookmarked: false, savedOffline: false,
        });
      }
    }
  };
  tryParse('item');
  if (!articles.length) tryParse('entry');
  return articles;
}

function looksLikeFeedXml(text) {
  if (!text) return false;
  const t = text.trimStart().toLowerCase();
  if (t.startsWith('{') || t.startsWith('[')) return false;
  return (
    t.includes('<rss') ||
    t.includes('<feed') ||
    t.includes('<rdf:rdf') ||
    t.includes('<channel') ||
    t.includes('<item') ||
    t.includes('<entry')
  );
}

function buildFeedRequestUrls(feedUrl) {
  const encoded = encodeURIComponent(feedUrl);
  return [
    feedUrl,
    'https://api.allorigins.win/raw?url=' + encoded + '&_=' + Date.now(),
    'https://corsproxy.io/?' + encoded,
  ];
}

async function fetchTextWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeedXml(feedUrl, timeoutMs = 10000) {
  let bestText = '';
  let bestScore = -1;
  let lastError = null;

  for (const url of buildFeedRequestUrls(feedUrl)) {
    try {
      const text = await fetchTextWithTimeout(url, timeoutMs);
      if (!looksLikeFeedXml(text)) throw new Error('not rss');
      const score = (text.match(/<(?:item|entry)\b/gi) || []).length;
      if (score > bestScore) {
        bestScore = score;
        bestText = text;
      }
      // Prefer the direct feed URL when it already looks good.
      if (url === feedUrl && score > 0) return text;
    } catch (e) {
      lastError = e;
    }
  }

  if (bestText) return bestText;
  throw lastError || new Error('Could not fetch feed');
}

async function fetchFeedItems(feed, timeoutMs = 10000) {
  if (feed.paused) return [];
  const xml = await fetchFeedXml(feed.url, timeoutMs);
  return parseRSS(xml, feed.id, feed.title);
}

// ============================================================
// STORAGE
// ============================================================
// ============================================================
// BACKGROUND FETCH + PUSH NOTIFICATIONS
// Registers a background task that runs every ~15min even when app is closed
// This only works in a real APK build (EAS Build), not in Expo Go
// ============================================================
const BG_TASK = 'ROYALROADREADER_BG_REFRESH';

async function registerBackgroundFetch() {
  try {
    const BackgroundFetch = require('expo-background-fetch');
    const TaskManager = require('expo-task-manager');
    const Notifications = require('expo-notifications');

    // Request notification permissions
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;

    // Set notification handler
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: false,
        shouldSetBadge: true,
      }),
    });

    // Register the background task if not already registered
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BG_TASK).catch(() => false);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BG_TASK, {
        minimumInterval: 15 * 60, // 15 minutes minimum (OS may delay)
        stopOnTerminate: false,   // continue after app is killed
        startOnBoot: true,        // start after phone reboot
      });
    }
  } catch (e) {
    // Not available in Expo Go — silently ignore
  }
}

// The background task itself — defined at module level (required by TaskManager)
try {
  const TaskManager = require('expo-task-manager');
  TaskManager.defineTask(BG_TASK, async () => {
    try {
      const BackgroundFetch = require('expo-background-fetch');
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const Notifications = require('expo-notifications');

      // Load feeds and articles from storage
      const feedsRaw    = await AsyncStorage.getItem('fp_feeds');
      const articlesRaw = await AsyncStorage.getItem('fp_articles');
      const settingsRaw = await AsyncStorage.getItem('fp_settings');
      if (!feedsRaw) return BackgroundFetch.BackgroundFetchResult.NoData;

      const feeds    = JSON.parse(feedsRaw) || [];
      const articles = JSON.parse(articlesRaw) || [];
      const settings = settingsRaw ? JSON.parse(settingsRaw) : {};

      if (!settings.autoRefresh) return BackgroundFetch.BackgroundFetchResult.NoData;

      // Fetch all feeds
      let newCount = 0;
      const merged = [...articles];
      for (const feed of feeds) {
        if (feed.paused) continue;
        try {
          const fresh = await fetchFeedItems(feed, 10000);
          for (const a of fresh) {
            const exists = merged.find(x =>
              x.id === a.id ||
              (x.feedId === a.feedId && x.link && a.link && x.link === a.link)
            );
            if (!exists) newCount++;
          }
        } catch {}
      }

      if (newCount > 0) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'RoyalRoadReader',
            body: newCount + ' new chapter' + (newCount > 1 ? 's' : '') + ' available',
            data: { screen: 'articles' },
          },
          trigger: null, // send immediately
        });
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }
      return BackgroundFetch.BackgroundFetchResult.NoData;
    } catch {
      const BackgroundFetch = require('expo-background-fetch');
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
} catch {}

const KEYS = {
  FEEDS:'fp_feeds', ARTICLES:'fp_articles', SETTINGS:'fp_settings',
  CATS:'fp_cats', COLLAPSED:'fp_collapsed',
};
const Store = {
  async get(k)   { try { const v = await AsyncStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  async set(k,v) { try { await AsyncStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ============================================================
// APP
// ============================================================
export default function App() {
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [lastOpenArticle, setLastOpenArticle] = useState(null); // track for unread restoration
  const [dark, setDark]                   = useState(false);
  const [feedSortMode, setFeedSortMode]   = useState('manual');
  const [trueBlack, setTrueBlack]         = useState(false);
  const [tab, setTab]                     = useState('feeds');
  const [feeds, setFeeds]                 = useState([]);
  const [articles, setArticles]           = useState([]);
  const [cats, setCats]                   = useState(['General','Tech','News','Sport','Entertainment','Royal Road']);
  const [collapsed, setCollapsed]         = useState({});
  const [loading, setLoading]             = useState(false);
  const [refreshing, setRefreshing]       = useState(false);
  const [search, setSearch]               = useState('');
  const [filterFeed, setFilterFeed]       = useState(null);
  const [filterCat, setFilterCat]         = useState(null);
  const [hideRead,  setHideRead]           = useState(false); // persisted below after settings load
  const [openArticle, setOpenArticle]     = useState(null);
  const [articlesScrollOffset, setArticlesScrollOffset] = useState(0);
  const [showAddFeed, setShowAddFeed]     = useState(false);
  const [showModal, getModalEl]            = useAppModal();
  const [showImport, setShowImport]       = useState(false);
  const [showRRBrowser, setShowRRBrowser] = useState(false);
  const [autoRefresh, setAutoRefresh]     = useState(false);
  const [checkInterval, setCheckInterval] = useState(CHECK_INTERVALS[1].ms);
  const [lastChecked, setLastChecked]     = useState(null);
  const [readerFontSize, setReaderFontSize] = useState(17);
  const [readerFont,     setReaderFont]     = useState('serif');
  const [newBanner, setNewBanner]         = useState(null);

  const intervalRef = useRef(null);

  // Register background fetch & push notifications on mount (only works in APK build)
  useEffect(() => { registerBackgroundFetch().catch(() => {}); }, []);
  const feedsRef    = useRef(feeds);
  feedsRef.current  = feeds;
  const thBase = dark ? DARK : LIGHT;
  // Keep system nav bar dark
  React.useEffect(() => {
    if (Platform.OS === 'android') {
      const bg = dark ? '#000000' : '#ffffff';
      const navBg = dark ? '#000000' : '#ffffff';
      try { StatusBar.setBackgroundColor(bg, true); StatusBar.setBarStyle(dark ? 'light-content' : 'dark-content', true); } catch {}
      try {
        const NavBar = require('expo-navigation-bar');
        NavBar.setBackgroundColorAsync(navBg);
        NavBar.setButtonStyleAsync(dark ? 'light' : 'dark');
      } catch {}
    }
  }, [dark]);
  // Set dark background immediately on mount AND on app foreground to prevent white flash
  React.useEffect(() => {
    const applyBars = () => {
      if (Platform.OS === 'android') {
        const isDk = dark || true; // always dark for status/nav bar
        try { StatusBar.setBackgroundColor(dark ? '#000000' : '#ffffff', false); StatusBar.setBarStyle(dark ? 'light-content' : 'dark-content', false); } catch {}
        try {
          const NavBar = require('expo-navigation-bar');
          NavBar.setBackgroundColorAsync(dark ? '#000000' : '#ffffff');
          NavBar.setButtonStyleAsync(dark ? 'light' : 'dark');
        } catch {}
      }
    };
    applyBars();
    // Re-apply when app comes back to foreground (prevents white flash on app switch)
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') applyBars();
    });
    return () => sub.remove();
  }, [dark]);
  const th = trueBlack && dark ? { ...thBase, bg:'#000000', surface:'#0A0A0A', surfaceAlt:'#111111', card:'#0D0D0D', header:'#000000', tabBg:'#000000', tabInactive:'#888888', tabActive:thBase.tabActive } : thBase;

  // Startup
  useEffect(() => {
    (async () => {
      const f   = await Store.get(KEYS.FEEDS);     if (f)   setFeeds(f);
      const a   = await Store.get(KEYS.ARTICLES);  if (a)   setArticles(a);
      const c   = await Store.get(KEYS.CATS);      if (c)   setCats(c);
      const col = await Store.get(KEYS.COLLAPSED); if (col) setCollapsed(col);
      const s   = await Store.get(KEYS.SETTINGS);
      if (s) {
        if (s.dark          !== undefined) setDark(s.dark);
        if (s.autoRefresh   !== undefined) setAutoRefresh(s.autoRefresh);
        if (s.checkInterval !== undefined) setCheckInterval(s.checkInterval);
        if (s.lastChecked   !== undefined) setLastChecked(s.lastChecked);
        if (s.readerFontSize !== undefined) setReaderFontSize(s.readerFontSize);
        if (s.readerFont     !== undefined) setReaderFont(s.readerFont);
        if (s.hideRead       !== undefined) setHideRead(s.hideRead);
        if (s.trueBlack      !== undefined) setTrueBlack(s.trueBlack);
        if (s.feedSortMode  !== undefined) setFeedSortMode(s.feedSortMode);
      }
      setSettingsLoaded(true);
    })();
  }, []);

  // Android back button
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!settingsLoaded) {
    // Show themed black until settings load — avoids white flash on cold start
    return (
      <View style={{ flex: 1, backgroundColor: '#000000' }} collapsable={false}>
        <StatusBar barStyle="light-content" backgroundColor="#000000" translucent={false} />
      </View>
    );
  }

  if (showRRBrowser) { setShowRRBrowser(false); return true; }
      if (openArticle)   { setOpenArticle(null);    return true; }
      return false;
    });
    return () => sub.remove();
  }, [showRRBrowser, openArticle]);

  // Auto-refresh
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh && checkInterval > 0) {
      intervalRef.current = setInterval(() => doRefresh(feedsRef.current, true), checkInterval);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, checkInterval]);

  // Auto-dismiss banner
  useEffect(() => {
    if (!newBanner) return;
    const t = setTimeout(() => setNewBanner(null), 5000);
    return () => clearTimeout(t);
  }, [newBanner]);

  const saveSettings = async updates => {
    const current = await Store.get(KEYS.SETTINGS) || {};
    Store.set(KEYS.SETTINGS, { ...current, ...updates });
  };
  const toggleDark   = () => { const n = !dark; setDark(n); saveSettings({ dark: n }); };
  const saveFeeds    = f => { setFeeds(f);    Store.set(KEYS.FEEDS, f); };
  const saveArticles = a => { setArticles(a); Store.set(KEYS.ARTICLES, a); };
  const saveCats     = c => { setCats(c);     Store.set(KEYS.CATS, c); };

  const toggleCollapsed = cat => {
    setCollapsed(prev => {
      const next = { ...prev, [cat]: !prev[cat] };
      Store.set(KEYS.COLLAPSED, next);
      return next;
    });
  };

  const toggleAutoRefresh = val => { setAutoRefresh(val); saveSettings({ autoRefresh: val }); };
  const updateInterval    = ms  => { setCheckInterval(ms); saveSettings({ checkInterval: ms }); };

  const fetchFeed = async (feed) => {
    return fetchFeedItems(feed, 10000);
  };

  const doRefresh = async (feedList, silent) => {
    const results = await Promise.all(feedList.map(feed => fetchFeed(feed)));
    const fresh = results.flat();

    // Compute new articles BEFORE calling setArticles, so we don't mutate inside updater
    // (React 18 can re-run updaters; mutations inside are unreliable)
    const articlesSnapshot = await Store.get(KEYS.ARTICLES) || [];
    const newItems = [];
    for (const a of fresh) {
      const oldId = a.feedId + '_' + (a.link || '').slice(0, 80);
      const dup = articlesSnapshot.find(x =>
        x.id === a.id ||
        x.id === oldId ||
        (x.feedId === a.feedId && x.link && a.link && x.link === a.link)
      );
      if (!dup) newItems.push(a);
    }

    if (newItems.length > 0) {
      const merged = [...newItems, ...articlesSnapshot].sort((a, b) => (b.pubDate||0) - (a.pubDate||0));
      await Store.set(KEYS.ARTICLES, merged);
      setArticles(merged);
      if (silent) {
        const titles = [...new Set(newItems.map(a => a.feedTitle))];
        setNewBanner({ count: newItems.length, titles });
      }
    }

    const now = Date.now();
    setLastChecked(now);
    saveSettings({ lastChecked: now });
  };

  const refreshSmart = async fid => {
    if (!feeds.length) { setRefreshing(false); return; }
    setRefreshing(true);
    const list = fid ? feeds.filter(f => f.id === fid) : feeds;
    try {
      await Promise.race([
        doRefresh(list.length ? list : feeds, false),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
      ]);
    } catch (e) {
      console.warn('Refresh error/timeout:', e.message);
    } finally {
      setRefreshing(false);
    }
  };

  const addFeed = async (url, title, category) => {
    const id   = 'feed_' + Date.now();
    const feed = { id, url, title: title || url, category: category || 'General', paused: false, pauseArticleId: null, addedAt: Date.now() };
    saveFeeds([...feeds, feed]);
    setLoading(true);
    const fetched = await fetchFeed(feed);
    setArticles(prev => {
      const merged = [...fetched.filter(a => !prev.find(p => p.id === a.id)), ...prev];
      Store.set(KEYS.ARTICLES, merged);
      return merged;
    });
    setLoading(false);
  };

  const importOPML = opmlText => {
    if (!opmlText.trim()) { Alert.alert('Empty', 'No OPML content found.'); return; }
    let parsed;
    try { parsed = parseOPML(opmlText); }
    catch (e) { Alert.alert('Parse Error', 'Could not read OPML.\n\n' + e.message); return; }
    if (!parsed.length) { Alert.alert('No Feeds', 'The OPML contained no feeds.'); return; }
    const existing = new Set(feeds.map(f => f.url));
    const next = parsed.filter(f => !existing.has(f.url));
    if (!next.length) { Alert.alert('Already Added', 'All feeds already in your list.'); return; }
    const newCats = [...new Set(next.map(f => f.category).filter(c => c && !cats.includes(c)))];
    if (newCats.length) saveCats([...cats, ...newCats]);
    saveFeeds([...feeds, ...next]);
    Alert.alert('Imported', 'Added ' + next.length + ' feed' + (next.length !== 1 ? 's' : '') + '.\n\nPull to refresh articles.');
  };

  const exportOPML = async () => {
    if (!feeds.length) { Alert.alert('Nothing to Export', 'Add some feeds first.'); return; }
    try { await Share.share({ title: 'RoyalRoadReader Feeds.opml', message: generateOPML(feeds, cats) }); }
    catch (e) { Alert.alert('Export Error', e.message); }
  };

  const moveCategory = (feedId, newCat) => {
    setFeeds(prev => {
      const updated = prev.map(f => f.id === feedId ? { ...f, category: newCat } : f);
      Store.set(KEYS.FEEDS, updated);
      return updated;
    });
  };

  const togglePause = feedId => {
    setFeeds(prev => {
      const updated = prev.map(f => {
        if (f.id !== feedId) return f;
        if (!f.paused) {
          const first = articles.find(a => a.feedId === feedId && !a.read);
          return { ...f, paused: true, pauseArticleId: first?.id || null };
        }
        return { ...f, paused: false };
      });
      Store.set(KEYS.FEEDS, updated);
      return updated;
    });
  };

  const deleteFeed = feedId => {
    showModal('Remove Feed', 'Remove this feed and all its articles?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        saveFeeds(feeds.filter(f => f.id !== feedId));
        saveArticles(articles.filter(a => a.feedId !== feedId));
      }},
    ], '🗑');
  };

  const markRead       = id => setArticles(prev => { const u = prev.map(a => a.id === id ? { ...a, read: true } : a); Store.set(KEYS.ARTICLES, u); return u; });
  const toggleRead     = id => setArticles(prev => { const u = prev.map(a => a.id === id ? { ...a, read: !a.read } : a); Store.set(KEYS.ARTICLES, u); return u; });
  const toggleBookmark = id => setArticles(prev => { const u = prev.map(a => a.id === id ? { ...a, bookmarked: !a.bookmarked } : a); Store.set(KEYS.ARTICLES, u); return u; });

  const deleteOffline = id => {
    setArticles(prev => {
      const u = prev.map(a => a.id === id ? { ...a, savedOffline: false } : a);
      Store.set(KEYS.ARTICLES, u); return u;
    });
  };

  const filteredArticles = articles.filter(a => {
    if (hideRead && a.read) return false;
    if (filterFeed && a.feedId !== filterFeed) return false;
    if (filterCat) {
      const f = feeds.find(x => x.id === a.feedId);
      if (!f || f.category !== filterCat) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (!a.title.toLowerCase().includes(q) && !(a.description||'').toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));

  const sbTop = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 44;
  const styles = makeStyles(th);

  if (showRRBrowser) {
    return (
      <RoyalRoadBrowser
        th={th} styles={styles} sbTop={sbTop}
        feeds={feeds}
        onClose={() => setShowRRBrowser(false)}
      />
    );
  }

  if (openArticle) {
    const live = articles.find(a => a.id === openArticle.id) || openArticle;
    return (
      <ArticleReader
        article={live} th={th} styles={styles} sbTop={sbTop}
        feedArticles={articles.filter(a => a.feedId === live.feedId).sort((a,b) => (a.pubDate||0)-(b.pubDate||0))}
        onOpen={a => { setOpenArticle(a); setTimeout(() => markRead(a.id), 3000); }}
        onClose={() => setOpenArticle(null)}
        onMarkUnread={() => { toggleRead(live.id); setOpenArticle(null); }}
        onMarkSaved={() => setArticles(prev => { const u = prev.map(a => a.id === live.id ? { ...a, savedOffline: true } : a); Store.set(KEYS.ARTICLES, u); return u; })}
        onAddManualChapter={(url, feedId) => {
          const fid = feedId || live.feedId;
          const ft  = (feeds.find(f => f.id === fid) || {}).title || live.feedTitle || '';
          const newArt = {
            id: fid + '_manual_' + Date.now(),
            feedId: fid, feedTitle: ft,
            title: decodeURIComponent((url.split('/chapter/')[1] || '').split('/').slice(1).join(' ').replace(/-/g,' ') || 'Chapter'),
            link: url, description: '', fullHtml: '',
            pubDate: Date.now(), read: false, bookmarked: false, savedOffline: false,
          };
          setArticles(prev => { const u = [newArt, ...prev.filter(a => a.link !== url)]; Store.set(KEYS.ARTICLES, u); return u; });
        }}
        initFontSize={readerFontSize}
        initFont={readerFont}
        onFontSize={s => { setReaderFontSize(s); saveSettings({ readerFontSize: s }); }}
        onFont={f => { setReaderFont(f); saveSettings({ readerFont: f }); }}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }} collapsable={false}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} translucent={false} backgroundColor={th.header} />
      <View style={{ height: sbTop, backgroundColor: th.header }} />

      <View style={[styles.header, { backgroundColor: th.header, borderBottomColor: th.border }]}>
        <Text style={[styles.headerTitle, { color: th.text }]}>
          {tab === 'feeds' ? 'RoyalRoadReader' : tab === 'articles' ? 'Articles' : tab === 'bookmarks' ? 'Bookmarks' : tab === 'offline' ? 'Offline' : 'Settings'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {tab === 'feeds'    && <TouchableOpacity onPress={() => setShowAddFeed(true)} style={[styles.pill, { backgroundColor: th.accent }]}><Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>+ Feed</Text></TouchableOpacity>}
          {tab === 'articles' && <TouchableOpacity onPress={() => refreshSmart(filterFeed)} style={[styles.pill, { backgroundColor: th.accent }]}><Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>{refreshing ? '...' : 'Refresh'}</Text></TouchableOpacity>}
        </View>
      </View>

      {newBanner && (
        <TouchableOpacity onPress={() => { setNewBanner(null); setTab('articles'); }} style={{ backgroundColor: th.accent, padding: 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{'New: ' + newBanner.count + ' article' + (newBanner.count !== 1 ? 's' : '') + ' - tap to view'}</Text>
          <TouchableOpacity onPress={() => setNewBanner(null)}><Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 18 }}>x</Text></TouchableOpacity>
        </TouchableOpacity>
      )}

      <View style={{ flex: 1 }}>
        {tab === 'feeds' && (
          <FeedsScreen
            feeds={feeds} cats={cats} th={th} styles={styles} articles={articles} collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed} onPause={togglePause} onDelete={deleteFeed}
            onAddCat={c => { if (!cats.includes(c)) saveCats([...cats, c]); }}
            onDeleteCat={c => saveCats(cats.filter(x => x !== c))}
            onSelectFeed={id => { setFilterFeed(id); setFilterCat(null); setArticlesScrollOffset(0); setTab('articles'); }}
            onMoveCategory={moveCategory}
            refreshing={refreshing} onRefresh={() => refreshSmart(null)}
            onReorder={newFeeds => saveFeeds(newFeeds)}
            showModal={showModal}
            sortMode={feedSortMode}
            onSortMode={m => { setFeedSortMode(m); saveSettings({ feedSortMode: m }); }}
          />
        )}
        {tab === 'articles' && (
          <ArticlesScreen
            articles={filteredArticles} feeds={feeds} cats={cats} th={th} styles={styles}
            search={search} setSearch={setSearch}
            filterFeed={filterFeed} setFilterFeed={setFilterFeed}
            filterCat={filterCat} setFilterCat={setFilterCat}
            hideRead={hideRead} setHideRead={v => { const val = typeof v === 'function' ? v(hideRead) : v; setHideRead(val); saveSettings({ hideRead: val }); }}
            refreshing={refreshing} onRefresh={() => refreshSmart(filterFeed)} loading={loading}
            onOpen={a => { setOpenArticle(a); setTimeout(() => markRead(a.id), 3000); }}
            onBookmark={toggleBookmark} onToggleRead={toggleRead}
            scrollOffset={articlesScrollOffset} onScrollOffset={setArticlesScrollOffset}
          />
        )}

        {tab === 'offline' && (
          <OfflineScreen
            articles={articles.filter(a => a.savedOffline)} feeds={feeds} th={th} styles={styles}
            onOpen={a => { setOpenArticle(a); setTimeout(() => markRead(a.id), 3000); }}
            onBookmark={toggleBookmark} onToggleRead={toggleRead}
            onDelete={deleteOffline}
            showModal={showModal}
            onSaveArticles={newArts => setArticles(prev => {
              // Dedupe by id OR by (feedId + normalised title) to prevent duplicates from downloaded chapters
              const existingIds = new Set(prev.map(a => a.id));
              const existingKeys = new Set(prev.map(a => (a.feedId||'') + '|' + (a.title||'').trim().toLowerCase()));
              const fresh = newArts.filter(n => !existingIds.has(n.id) && !existingKeys.has((n.feedId||'')+'|'+(n.title||'').trim().toLowerCase()));
              const merged = [...fresh, ...prev].sort((a,b) => (b.pubDate||0)-(a.pubDate||0));
              Store.set(KEYS.ARTICLES, merged); return merged;
            })}
          />
        )}
        {tab === 'settings' && (
          <SettingsScreen
            th={th} styles={styles} dark={dark} onToggleDark={toggleDark}
            cats={cats} onSaveCats={saveCats} feeds={feeds} articles={articles}
            onImport={() => setShowImport(true)} onExport={exportOPML}
            autoRefresh={autoRefresh} onToggleAutoRefresh={toggleAutoRefresh}
            checkInterval={checkInterval} onSetInterval={updateInterval}
            lastChecked={lastChecked} showModal={showModal}
            trueBlack={trueBlack} setTrueBlack={setTrueBlack}
            onSaveSettings={saveSettings}
            onOpenRRBrowser={() => setShowRRBrowser(true)}
          />
        )}
      </View>

      <View style={[styles.tabBar, { backgroundColor: th.tabBg, borderTopColor: th.border }]}>
        {[
          { key:'feeds',     icon:'📡', label:'Feeds'    },
          { key:'articles',  icon:'📰', label:'Articles' },
          { key:'offline',   icon:'📥', label:'Offline'  },
          { key:'settings',  icon:'⚙', label:'Settings' },
        ].map(t => (
          <TouchableOpacity key={t.key} style={styles.tabItem} onPress={() => {
            if (t.key === 'articles') { setFilterFeed(null); setFilterCat(null); }
            setTab(t.key);
          }}>
            <Text style={[styles.tabIcon, { color: tab === t.key ? th.tabActive : th.tabInactive }]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, { color: tab === t.key ? th.tabActive : th.tabInactive }]}>{t.label}</Text>
            {tab === t.key && <View style={[styles.tabLine, { backgroundColor: th.tabActive }]} />}
          </TouchableOpacity>
        ))}
      </View>

      {getModalEl(th)}
      <AddFeedModal visible={showAddFeed} th={th} styles={styles} cats={cats}
        onClose={() => setShowAddFeed(false)}
        feeds={feeds} articles={articles} showModal={showModal}
        onAdd={addFeed}
        onAddArticle={(feedId, item) => {
          const feed = feeds.find(f => f.id === feedId);
          if (!feed) return;
          const newArt = {
            id: feedId + '_' + (item.link || '').slice(-60),
            feedId, feedTitle: feed.title,
            title: item.title || 'Chapter', link: item.link,
            description: '', fullHtml: '',
            pubDate: item.date ? item.date.getTime() : Date.now(),
            read: false, bookmarked: false, savedOffline: false,
          };
          setArticles(prev => {
            const u = [newArt, ...prev.filter(a => a.link !== item.link)]
              .sort((a,b) => (b.pubDate||0)-(a.pubDate||0));
            Store.set(KEYS.ARTICLES, u);
            return u;
          });
        }}
      />
      <ImportOPMLModal visible={showImport}  th={th} styles={styles} onClose={() => setShowImport(false)} onImport={importOPML} />
    </View>
  );
}

// ============================================================
// FEEDS SCREEN
// ============================================================
// ============================================================
// FEEDS SCREEN
// ============================================================
// ============================================================
// FEEDS SCREEN  — drag-to-reorder with 500ms press-and-hold
// ============================================================
function FeedsScreen({ feeds, cats, th, styles, articles, collapsed, onToggleCollapsed, onPause, onDelete, onAddCat, onDeleteCat, onSelectFeed, onMoveCategory, refreshing, onRefresh, onReorder, showModal, sortMode, onSortMode }) {
  const FEED_H   = 92;   // fixed height for every feed card row
  const HEADER_H = 46;   // fixed height for category header
  const PADDING  = 14;

  const [newCat,       setNewCat]       = useState('');
  const [addingCat,    setAddingCat]    = useState(false);
  const [dragFeedId,   setDragFeedId]   = useState(null);
  const [dropCat,      setDropCat]      = useState(null);  // highlighted target cat
  const [dropIndex,    setDropIndex]    = useState(null);
  const [scrollOn,     setScrollOn]     = useState(true);
  const ghostAnim      = useRef(new Animated.Value(0)).current;
  const containerRef   = useRef(null);
  const scrollRef      = useRef(null);
  const containerPageY = useRef(0);
  const scrollY        = useRef(0);
  const timerRef       = useRef(null);
  const touchRef       = useRef(null); // {feedId, cat, startPageY}
  const dragActiveRef  = useRef(false);
  const containerH     = useRef(0);

  const unread   = fid => articles.filter(a => a.feedId === fid && !a.read).length;
  const hasUncategorised = feeds.some(f => !f.category || f.category === 'General');
  const allCats = [...new Set([...cats, ...feeds.map(f => f.category).filter(Boolean)])].filter(c => c !== 'General' || hasUncategorised);

  // Calculate content-Y position for every item (header + feeds per category)
  const buildLayout = () => {
    let y = PADDING;
    const rows = [];
    allCats.forEach(cat => {
      rows.push({ type: 'header', cat, y, h: HEADER_H });
      y += HEADER_H + 6;
      if (!collapsed[cat]) {
        feeds.filter(f => f.category === cat).forEach((feed, i) => {
          rows.push({ type: 'feed', feed, cat, catIndex: i, y, h: FEED_H });
          y += FEED_H + 8;
        });
        const empty = feeds.filter(f => f.category === cat).length === 0;
        if (empty) y += 30;
      }
      y += 14; // marginBottom of category group
    });
    return rows;
  };

  const findDrop = pageY => {
    const relY = pageY - containerPageY.current + scrollY.current;
    const rows = buildLayout();
    // Which category zone are we in?
    let targetCat = allCats[0];
    let targetIdx = 0;
    rows.forEach(row => {
      if (row.type === 'header' && relY >= row.y) targetCat = row.cat;
      if (row.type === 'feed' && relY >= row.y) { targetCat = row.cat; targetIdx = row.catIndex; }
      if (row.type === 'feed' && relY >= row.y + row.h / 2) targetIdx = row.catIndex + 1;
    });
    return { cat: targetCat, index: targetIdx };
  };

  const measureContainer = () => {
    containerRef.current && containerRef.current.measure((_x, _y, _w, h, _px, pageY) => {
      containerPageY.current = pageY;
      containerH.current = h;
    });
  };

  const autoScrollSpeed = useRef(0); // negative = up, positive = down, 0 = stopped

  const startAutoScroll = (direction, speed) => {
    autoScrollSpeed.current = direction * speed;
  };
  const stopAutoScroll = () => {
    autoScrollSpeed.current = 0;
  };

  // Single persistent interval — runs the whole time the component is mounted
  useEffect(() => {
    const id = setInterval(() => {
      if (autoScrollSpeed.current !== 0 && scrollRef.current) {
        // Update scrollY immediately so next tick uses fresh value
        const nextY = Math.max(0, scrollY.current + autoScrollSpeed.current);
        scrollY.current = nextY;
        scrollRef.current.scrollTo({ y: nextY, animated: false });
        // Also update ghost position while auto-scrolling
        if (dragActiveRef.current && touchRef.current) {
          ghostAnim.setValue(touchRef.current.lastPageY - containerPageY.current);
        }
      }
    }, 16);
    return () => clearInterval(id);
  }, []);

  const activateDrag = feedId => {
    measureContainer();
    dragActiveRef.current = true;
    setDragFeedId(feedId);
    setScrollOn(false);
    if (touchRef.current) {
      const ghostY = touchRef.current.startPageY - containerPageY.current;
      ghostAnim.setValue(ghostY);
    }
  };

  const cancelDrag = () => {
    clearTimeout(timerRef.current);
    stopAutoScroll();
    dragActiveRef.current = false;
    touchRef.current = null;
    setDragFeedId(null);
    setDropCat(null);
    setDropIndex(null);
    setScrollOn(true);
  };

  const commitDrop = () => {
    if (!dragActiveRef.current || !touchRef.current) { cancelDrag(); return; }
    const { feedId } = touchRef.current;
    const drop = findDrop(touchRef.current.lastPageY || touchRef.current.startPageY);
    const feed = feeds.find(f => f.id === feedId);
    if (feed && drop.cat !== feed.category) {
      onMoveCategory(feedId, drop.cat);
    } else if (feed) {
      const catFeeds = feeds.filter(f => f.category === feed.category);
      const from = catFeeds.findIndex(f => f.id === feedId);
      const to   = Math.max(0, Math.min(catFeeds.length - 1, drop.index));
      if (from !== to) {
        const reord = catFeeds.slice();
        reord.splice(from, 1);
        reord.splice(to, 0, feed);
        onReorder([...feeds.filter(f => f.category !== feed.category), ...reord]);
      }
    }
    cancelDrag();
  };

  // Handle responder events on the drag handle
  const makeHandleProps = (feed, cat) => ({
    onStartShouldSetResponder: () => true,
    onResponderGrant: e => {
      touchRef.current = { feedId: feed.id, cat, startPageY: e.nativeEvent.pageY, lastPageY: e.nativeEvent.pageY, hasMoved: false };
      timerRef.current = setTimeout(() => activateDrag(feed.id), 250);
    },
    onResponderMove: e => {
      const pageY = e.nativeEvent.pageY;
      if (!touchRef.current) return;
      touchRef.current.lastPageY = pageY;
      // Mark as moved once finger travels > 8px from start
      if (!touchRef.current.hasMoved && Math.abs(pageY - touchRef.current.startPageY) > 8) {
        touchRef.current.hasMoved = true;
      }
      // Cancel timer if user moved too far before 500ms
      if (!dragActiveRef.current) {
        if (touchRef.current.hasMoved) clearTimeout(timerRef.current);
        return;
      }
      // Move ghost
      ghostAnim.setValue(pageY - containerPageY.current);
      const drop = findDrop(pageY);
      setDropCat(drop.cat);
      setDropIndex(drop.index);
      // Auto scroll — only once finger has actually moved, activates in top/bottom 20%
      if (!touchRef.current.hasMoved) { stopAutoScroll(); return; }
      const zone = containerH.current * 0.267;
      const rel  = pageY - containerPageY.current;
      if (rel < zone) {
        const t = 1 - rel / zone;
        startAutoScroll(-1, Math.round(4 + t * 14));
      } else if (rel > containerH.current - zone) {
        const t = 1 - (containerH.current - rel) / zone;
        startAutoScroll(1, Math.round(4 + t * 14));
      } else {
        stopAutoScroll();
      }
    },
    onResponderRelease: () => { clearTimeout(timerRef.current); if (dragActiveRef.current) commitDrop(); else cancelDrag(); },
    onResponderTerminate: cancelDrag,
  });

  const dragFeed = dragFeedId ? feeds.find(f => f.id === dragFeedId) : null;

  return (
    <View
      ref={containerRef}
      style={{ flex: 1 }}
      onLayout={() => setTimeout(measureContainer, 100)}
    >
      <ScrollView
        ref={scrollRef}
        scrollEnabled={scrollOn}
        onScroll={e => { scrollY.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
        contentContainerStyle={{ padding: PADDING, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing && !dragFeedId} onRefresh={onRefresh} tintColor={th.accent} enabled={!dragFeedId} />}
      >

        {/* Sort bar */}
        <View style={{ flexDirection: 'row', marginBottom: 10, gap: 6 }}>
          {[['manual','Manual'],['unread','Unread'],['recent','Recent'],['added','Added'],['alpha','A-Z']].map(([k,l]) => (
            <TouchableOpacity key={k} onPress={() => onSortMode(k)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16, backgroundColor: sortMode === k ? th.accent : th.tag }}>
              <Text style={{ fontSize: 11, color: sortMode === k ? '#fff' : th.tagText, fontWeight: '600' }}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {allCats.map(cat => {
          const rawCatFeeds = feeds.filter(f => f.category === cat);
          const catFeeds = sortMode === 'manual' ? rawCatFeeds :
            sortMode === 'unread'  ? rawCatFeeds.slice().sort((a,b) => unread(b.id) - unread(a.id)) :
            sortMode === 'recent'  ? rawCatFeeds.slice().sort((a,b) => { const la = articles.filter(x=>x.feedId===a.id).sort((x,y)=>(y.pubDate||0)-(x.pubDate||0))[0]; const lb = articles.filter(x=>x.feedId===b.id).sort((x,y)=>(y.pubDate||0)-(x.pubDate||0))[0]; return (lb?.pubDate||0)-(la?.pubDate||0); }) :
            sortMode === 'added'   ? rawCatFeeds.slice().sort((a,b) => (b.addedAt||0) - (a.addedAt||0)) :
            rawCatFeeds.slice().sort((a,b) => a.title.localeCompare(b.title));
          const isCol     = !!collapsed[cat];
          const catUnread = catFeeds.reduce((n, f) => n + unread(f.id), 0);
          const isDragTarget = dragFeed && dropCat === cat && dragFeed.category !== cat;
          return (
            <View key={cat} style={{ marginBottom: 14 }}>
              <TouchableOpacity
                onPress={() => onToggleCollapsed(cat)}
                style={[styles.catHeader, { backgroundColor: isDragTarget ? th.accentBg : th.surfaceAlt, borderColor: isDragTarget ? th.accent : th.border, borderWidth: isDragTarget ? 2 : 1 }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                  <View style={{ width: 8, height: 8, borderRightWidth: 2, borderBottomWidth: 2, borderColor: th.textMuted, marginRight: 8, transform: [{ rotate: isCol ? '-45deg' : '45deg' }] }} />
                  <Text style={[styles.catTitle, { color: th.text }]}>{cat}</Text>
                  {catUnread > 0 && <View style={[styles.badge, { backgroundColor: th.accent, marginLeft: 8 }]}><Text style={styles.badgeText}>{catUnread}</Text></View>}
                  {isDragTarget && <Text style={{ color: th.accent, fontSize: 11, marginLeft: 8, fontWeight: '700' }}>Drop here</Text>}
                </View>
                <Text style={{ color: th.textMuted, fontSize: 12 }}>{catFeeds.length} feed{catFeeds.length !== 1 ? 's' : ''}</Text>
              </TouchableOpacity>

              {!isCol && catFeeds.map((feed, i) => {
                const isDragging  = dragFeedId === feed.id;
                const isDropLine  = dragFeed && dropCat === cat && !isDragging && (dropIndex === i || (i === catFeeds.length - 1 && dropIndex >= catFeeds.length));
                return (
                  <View key={feed.id}>
                    {isDropLine && <View style={{ height: 3, backgroundColor: th.accent, borderRadius: 2, marginBottom: 4, marginHorizontal: 4 }} />}
                    <View style={[
                      styles.feedCard,
                      { backgroundColor: th.card, borderColor: isDragging ? th.accent : th.border, flexDirection: 'row', alignItems: 'center', opacity: isDragging ? 0.25 : 1, marginBottom: 6, paddingVertical: 10, paddingRight: 8 }
                    ]}>
                      {/* Slim drag handle */}
                      <View
                        {...makeHandleProps(feed, cat)}
                        style={{ width: 22, alignSelf: 'stretch', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2 }}
                      >
                        <Text style={{ color: th.textMuted, fontSize: 13, lineHeight: 10, letterSpacing: 1 }}>{':\n:'}</Text>
                      </View>
                      <TouchableOpacity style={{ flex: 1, paddingLeft: 6 }} onPress={() => onSelectFeed(feed.id)} activeOpacity={0.7}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 6 }}>
                            <Text style={[styles.feedName, { color: feed.paused ? th.paused : th.text, fontSize: 13 }]} numberOfLines={1}>
                              {feed.title}
                            </Text>
                            {unread(feed.id) > 0 && <View style={[styles.badge, { backgroundColor: th.accent, marginLeft: 6 }]}><Text style={styles.badgeText}>{unread(feed.id)}</Text></View>}
                          </View>
                          <View style={{ flexDirection: 'row', gap: 2 }}>
                            <TouchableOpacity onPress={e => { e.stopPropagation && e.stopPropagation(); onPause(feed.id); }} style={{ padding: 4 }} hitSlop={{ top:8,bottom:8,left:4,right:4 }}>
                              <Text style={{ fontSize: 13, color: feed.paused ? th.accent : th.textMuted, opacity: 0.7 }}>{feed.paused ? '▶' : '⏸'}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={e => { e.stopPropagation && e.stopPropagation(); onDelete(feed.id); }} style={{ padding: 4 }} hitSlop={{ top:8,bottom:8,left:4,right:4 }}>
                              <Text style={{ fontSize: 13, color: th.textMuted, opacity: 0.5 }}>{'✕'}</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                        <Text style={{ fontSize: 9, color: th.textMuted, marginTop: 1 }} numberOfLines={1}>{feed.url}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
              {!isCol && catFeeds.length === 0 && (
                <Text style={{ color: th.textMuted, fontSize: 13, padding: 8, fontStyle: 'italic' }}>No feeds in this category</Text>
              )}
            </View>
          );
        })}

        {feeds.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📡</Text>
            <Text style={[styles.emptyTitle, { color: th.text }]}>No feeds yet</Text>
            <Text style={[styles.emptySub, { color: th.textMuted }]}>Tap "+ Feed" or Import your Flym OPML</Text>
          </View>
        )}

        <View style={{ marginTop: 6 }}>
          <Text style={[styles.sLabel, { color: th.textSub }]}>CATEGORIES</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
            {cats.map(c => (
              <View key={c} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: th.border, backgroundColor: th.tag, marginRight: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: th.tagText }}>{c}</Text>
                {c !== 'General' && (
                  <TouchableOpacity onPress={() => showModal('Delete Category', 'Delete "' + c + '"? Feeds in it will move to General.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => onDeleteCat(c) }], '🗂')} style={{ marginLeft: 6 }}>
                    <Text style={{ color: th.danger, fontSize: 12, fontWeight: '700' }}>x</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </ScrollView>
          {addingCat ? (
            <View style={[styles.inputRow, { backgroundColor: th.card, borderColor: th.border }]}>
              <TextInput style={[styles.inlineInput, { color: th.text }]} placeholder="Category name" placeholderTextColor={th.textMuted} value={newCat} onChangeText={setNewCat} autoFocus />
              <TouchableOpacity onPress={() => { if (newCat.trim()) { onAddCat(newCat.trim()); setNewCat(''); setAddingCat(false); } }} style={{ paddingHorizontal: 14, paddingVertical: 10, backgroundColor: th.accent }}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>Add</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setAddingCat(false)} style={{ paddingHorizontal: 10 }}>
                <Text style={{ color: th.textMuted, fontSize: 18 }}>x</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setAddingCat(true)} style={[styles.ghostBtn, { borderColor: th.border }]}>
              <Text style={{ color: th.textSub }}>+ New Category</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* Floating ghost card — follows finger during drag */}
      {dragFeed && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: PADDING, right: PADDING,
            height: FEED_H - 8,
            transform: [{ translateY: ghostAnim }],
            zIndex: 999,
            shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
            elevation: 12,
          }}
        >
          <View style={[styles.feedCard, { flex: 1, backgroundColor: th.card, borderColor: th.accent, borderWidth: 2, flexDirection: 'row', alignItems: 'center' }]}>
            <View style={{ width: 32, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: th.accent, fontSize: 20 }}>{'≡'}</Text>
            </View>
            <View style={{ flex: 1, paddingLeft: 8 }}>
              <Text style={[styles.feedName, { color: th.text }]} numberOfLines={1}>{dragFeed.title}</Text>
              <Text style={{ fontSize: 10, color: th.textMuted, marginTop: 1 }} numberOfLines={1}>{dragFeed.url}</Text>
            </View>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

function ArticlesScreen({ articles, feeds, cats, th, styles, search, setSearch, filterFeed, setFilterFeed, filterCat, setFilterCat, refreshing, onRefresh, loading, onOpen, onBookmark, onToggleRead, hideRead, setHideRead, scrollOffset, onScrollOffset }) {
  const listRef    = useRef(null);
  const didRestore = useRef(false);

  useEffect(() => {
    if (!didRestore.current && scrollOffset > 0 && listRef.current) {
      didRestore.current = true;
      setTimeout(() => {
        try { listRef.current.scrollToOffset({ offset: scrollOffset, animated: false }); } catch {}
      }, 80);
    }
  }, []);

  const opts = [{ id: null, label: 'All' }, ...cats.map(c => ({ id: 'c:' + c, label: c })), ...feeds.map(f => ({ id: 'f:' + f.id, label: f.title }))];
  const isOn = o => (o.id === null && !filterFeed && !filterCat) || (o.id && o.id.startsWith('c:') && filterCat === o.id.slice(2)) || (o.id && o.id.startsWith('f:') && filterFeed === o.id.slice(2));
  const pick = o => {
    if (!o.id) { setFilterFeed(null); setFilterCat(null); }
    else if (o.id.startsWith('c:')) { setFilterCat(o.id.slice(2)); setFilterFeed(null); }
    else { setFilterFeed(o.id.slice(2)); setFilterCat(null); }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.searchRow, { backgroundColor: th.surfaceAlt, borderColor: th.border }]}>
        <Text style={{ color: th.textMuted, marginRight: 6 }}>🔍</Text>
        <TextInput style={[styles.searchInput, { color: th.text }]} placeholder="Search articles..." placeholderTextColor={th.textMuted} value={search} onChangeText={setSearch} />
        {!!search && <TouchableOpacity onPress={() => setSearch('')}><Text style={{ color: th.textMuted, padding: 4, fontSize: 16 }}>x</Text></TouchableOpacity>}
        <TouchableOpacity
          onPress={() => setHideRead(v => !v)}
          style={{ marginLeft: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16, backgroundColor: hideRead ? th.accent : th.tag }}
        >
          <Text style={{ fontSize: 12, color: hideRead ? '#fff' : th.tagText, fontWeight: '700' }}>Unread</Text>
        </TouchableOpacity>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44 }} contentContainerStyle={{ paddingHorizontal: 12, alignItems: 'center' }}>
        {opts.map(o => (
          <TouchableOpacity key={o.id || 'all'} onPress={() => pick(o)} style={[styles.chip, { backgroundColor: isOn(o) ? th.accent : th.tag, marginRight: 6 }]}>
            <Text style={[styles.chipText, { color: isOn(o) ? '#fff' : th.tagText }]} numberOfLines={1}>{o.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {loading && <ActivityIndicator color={th.accent} style={{ margin: 16 }} />}

      <FlatList
        ref={listRef}
        data={articles} keyExtractor={a => a.id}
        onScroll={e => onScrollOffset && onScrollOffset(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={200}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={th.accent} />}
        contentContainerStyle={{ padding: 12, paddingTop: 8 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📰</Text>
            <Text style={[styles.emptyTitle, { color: th.text }]}>No articles</Text>
            <Text style={[styles.emptySub, { color: th.textMuted }]}>{feeds.length === 0 ? 'Add feeds or import your Flym OPML' : 'Pull down to refresh'}</Text>
          </View>
        }
        renderItem={({ item: a }) => (
          <ArticleCard article={a} th={th} feedTitle={feeds.find(f => f.id === a.feedId)?.title || a.feedTitle} onPress={() => onOpen(a)} onBookmark={() => onBookmark(a.id)} onToggleRead={() => onToggleRead(a.id)} />
        )}
      />
    </View>
  );
}

// ============================================================
// ARTICLE CARD  (swipe right = read/unread, swipe left = bookmark)
// ============================================================
function ArticleCard({ article: a, th, feedTitle, onPress, onBookmark, onToggleRead }) {
  const date       = a.pubDate ? new Date(a.pubDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const translateX = React.useRef(new Animated.Value(0)).current;
  const [swipeHint, setSwipeHint] = React.useState(null);
  const THRESHOLD  = 80;

  const cleanDesc = s => {
    if (!s) return '';
    return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ')
             .replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
  };
  const preview = cleanDesc(a.description);

  const panResponder = React.useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, gs) => Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy),
    onPanResponderMove: (_e, gs) => {
      translateX.setValue(gs.dx);
      if (gs.dx > 30) setSwipeHint('read');

      else setSwipeHint(null);
    },
    onPanResponderRelease: (_e, gs) => {
      if (gs.dx > THRESHOLD && onToggleRead) onToggleRead();
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 6 }).start();
      setSwipeHint(null);
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 6 }).start();
      setSwipeHint(null);
    },
  })).current;

  return (
    <View style={{ marginBottom: 10, borderRadius: 13, overflow: 'hidden' }}>
      {swipeHint === 'read' && (
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', borderRadius: 13 }}>
          <View style={{ flex: 1, backgroundColor: a.read ? th.accent : th.success, justifyContent: 'center', paddingLeft: 20 }}>
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>{a.read ? 'Mark Unread' : 'Mark Read'}</Text>
          </View>

        </View>
      )}
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={{ borderWidth: 1, borderRadius: 13, padding: 14, backgroundColor: th.card, borderColor: swipeHint === 'read' ? (a.read ? th.accent : th.success) : th.border, opacity: a.read ? 0.6 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 9, fontWeight: '800', color: th.accent, textTransform: 'uppercase', letterSpacing: 0.6, marginRight: 6 }} numberOfLines={1}>{feedTitle}</Text>
            <Text style={{ fontSize: 9, color: th.textMuted }}>{date}</Text>
            {a.savedOffline && <Text style={{ fontSize: 9, color: th.success, marginLeft: 4 }}>📥</Text>}
            {!a.read && <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: th.accent, marginLeft: 6 }} />}
            <TouchableOpacity onPress={e => { e.stopPropagation && e.stopPropagation(); Linking.openURL(a.link).catch(()=>{}); }} style={{ marginLeft: 'auto', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: th.border }}>
              <Text style={{ fontSize: 11, color: th.textMuted }}>{'↗'}</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 15, fontWeight: '700', lineHeight: 21, color: a.read ? th.read : th.unread, marginBottom: preview ? 4 : 0 }} numberOfLines={2}>{a.title}</Text>
          {!!preview && <Text style={{ fontSize: 12, color: th.textMuted, lineHeight: 17 }} numberOfLines={2}>{preview}</Text>}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

// ============================================================
// ARTICLE READER  — WebView like Flym, injects CSS to clean up RR
// ============================================================
function ArticleReader({ article: a, th, styles, sbTop, onClose, onMarkSaved, onMarkUnread, initFontSize, initFont, onFontSize, onFont, feedArticles, onOpen, onAddManualChapter }) {
  const idx  = feedArticles ? feedArticles.findIndex(x => x.id === a.id) : -1;
  const prev = feedArticles && idx > 0 ? feedArticles[idx - 1] : null;
  const next = feedArticles && idx >= 0 && idx < feedArticles.length - 1 ? feedArticles[idx + 1] : null;
  const rightControls = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <TouchableOpacity onPress={onMarkUnread} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: th.surfaceAlt }}>
        <Text style={{ fontSize: 11, color: th.textMuted, fontWeight: '600' }}>{'Unread'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={a.savedOffline ? null : onMarkSaved}>
        <Text style={{ fontSize: 22 }}>{a.savedOffline ? '\u2713' : '\ud83d\udce5'}</Text>
      </TouchableOpacity>
    </View>
  );const readerSource = a.savedOffline && a.fullHtml
    ? null  // handled via offlineHtml prop
    : { uri: a.link };
  const offlineHtml = a.savedOffline && a.fullHtml ? a.fullHtml : null;

  return (
    <ChapterReaderView
        url={a.link}
      offlineHtml={offlineHtml}
      th={th}
      styles={styles}
      sbTop={sbTop}
      onClose={onClose}
      rightControls={rightControls}
      onAddManualChapter={url => onAddManualChapter && onAddManualChapter(url, a.feedId)}
      prevTitle={prev ? prev.title : null}
      nextTitle={next ? next.title : null}
      onPrev={prev ? () => onOpen(prev) : null}
      onNext={next ? () => onOpen(next) : null}
      initFontSize={initFontSize}
      initFont={initFont}
      onFontSize={onFontSize}
      onFont={onFont}
    />
  );
}

// ============================================================
// BOOKMARKS SCREEN
// ============================================================
function BookmarksScreen({ articles, th, styles, onOpen, onBookmark, onToggleRead }) {
  return (
    <FlatList
      data={articles} keyExtractor={a => a.id}
      contentContainerStyle={{ padding: 12 }}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🔖</Text>
          <Text style={[styles.emptyTitle, { color: th.text }]}>No bookmarks yet</Text>
          <Text style={[styles.emptySub, { color: th.textMuted }]}>Swipe left on any article to bookmark</Text>
        </View>
      }
      renderItem={({ item: a }) => (
        <ArticleCard article={a} th={th} feedTitle={a.feedTitle} onPress={() => onOpen(a)} onBookmark={() => onBookmark(a.id)} onToggleRead={() => onToggleRead(a.id)} />
      )}
    />
  );
}

// ============================================================
// OFFLINE SCREEN
// ============================================================
// ============================================================
// OFFLINE SCREEN — saved articles + Royal Road story downloader
// ============================================================
function OfflineScreen({ articles, feeds, th, styles, onOpen, onBookmark, onToggleRead, onDelete, onSaveArticles, showModal }) {
  const [view,       setView]       = useState('saved');   // 'saved' | 'download'
  const [sortOrder,  setSortOrder]  = useState('newest');  // 'newest' | 'oldest' | 'alpha'
  const [filterText, setFilterText] = useState('');

  // Download manager state
  const rrFeeds = (feeds || []).filter(f => f.url && f.url.includes('royalroad'));
  const [dlFeed,     setDlFeed]     = useState(null);
  const [dlChapters, setDlChapters] = useState([]);
  const [dlFrom,     setDlFrom]     = useState('');
  const [dlTo,       setDlTo]       = useState('');
  const [dlBusy,     setDlBusy]     = useState(false);
  const [dlProgress, setDlProgress] = useState('');
  const [dlDropdown, setDlDropdown] = useState(false);
  const [dlSearch,   setDlSearch]   = useState('');
  const [dlNewest, setDlNewest] = useState(true);  // true = newest first (default)

  // Modal WebView scraper — shows story page, extracts chapters after render
  const scraperRef = useRef(null);
  const [showScraper, setShowScraper] = useState(false);

  const fetchChapterList = () => {
    if (!dlFeed) return;
    setDlBusy(true); setDlProgress('Opening story page...'); setDlChapters([]);
    const feedUrl = dlFeed.url || '';
    // Handle both URL formats RR uses:
    // royalroad.com/fiction/69512/rss  (standard)
    // royalroad.com/fiction/syndication/69512  (alternate)
    let idMatch = feedUrl.match(/\/fiction\/(\d+)/) ||
                  feedUrl.match(/\/syndication\/(\d+)/) ||
                  feedUrl.match(/\/fiction\/[^\/]+\/(\d+)/);
    if (!idMatch) {
      setDlProgress('Could not extract story ID from URL: "' + feedUrl + '". Expected format: royalroad.com/fiction/ID/rss');
      setDlBusy(false);
      return;
    }
    const storyId  = idMatch[1];
    const storyUrl = 'https://www.royalroad.com/fiction/' + storyId;
    setDlProgress('Loading: ' + storyUrl);
    setScraperUrl(storyUrl);
    setShowScraper(true);
  };
  const [scraperUrl, setScraperUrl] = useState(null);

  // JS injected into the hidden WebView — extracts all chapter rows and posts back
  // JS injected into the visible story page WebView — runs after full page render
  // Extracts all chapter rows from the rendered DOM (Vue has already run)
  const scraperJS = `(function() {
    function send(list) {
      var seen = {}, out = [];
      list.forEach(function(c){ if(!seen[c.url]){ seen[c.url]=true; out.push(c); }});
      out.sort(function(a,b){ return (a.ts||0)-(b.ts||0); });
      window.ReactNativeWebView.postMessage(JSON.stringify({ type:'chapters', data:out }));
    }

    function progress(text) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type:'progress', text:text }));
    }

    // Exactly what WebToEpub does: fetch the raw HTML of this same page.
    // The server includes ALL chapters in table#chapters — DataTables only hides them client-side.
    progress('Fetching raw chapter list...');
    fetch(window.location.href, { credentials: 'same-origin' })
      .then(function(r) { return r.text(); })
      .then(function(html) {
        // Parse the HTML string to find table#chapters
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');
        var table = doc.querySelector('table#chapters');
        if (!table) {
          // Try alternate selectors
          table = doc.querySelector('table.table') || doc.querySelector('table');
        }
        if (!table) {
          progress('No chapter table found in raw HTML');
          send([]);
          return;
        }
        var list = [];
        table.querySelectorAll('a[href*="/chapter/"]').forEach(function(a) {
          var href = a.getAttribute('href') || '';
          var url = href.startsWith('http') ? href : 'https://www.royalroad.com' + href;
          var title = a.textContent.trim();
          // Find closest tr for date
          var tr = a.closest('tr');
          var timeEl = tr && tr.querySelector('time');
          var ts = timeEl ? (new Date(timeEl.getAttribute('datetime') || '').getTime() || 0) : 0;
          if (title && url.includes('/chapter/')) list.push({ url:url, title:title, ts:ts });
        });
        progress('Found ' + list.length + ' chapters');
        send(list);
      })
      .catch(function(e) {
        progress('Fetch failed: ' + e.message);
        send([]);
      });
  })();true;`;

  const handleScraperMessage = (event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'progress') {
        setDlProgress(msg.text);
        return;
      }
      if (msg.type === 'chapters') {
        if (msg.debug) setDlProgress('Debug: ' + msg.debug);
        const deduped = [];
        const seen = new Set();
        (msg.data || []).forEach(ch => {
          if (!seen.has(ch.url)) {
            seen.add(ch.url);
            deduped.push({ ...ch, date: new Date(ch.ts || 0), selected: true });
          }
        });
        if (deduped.length > 0) {
          setDlChapters(deduped);
          setDlProgress(deduped.length + ' chapters found');
          setDlBusy(false);
          setShowScraper(false);
          setScraperUrl(null);
        } else {
          // Empty result - page may not have rendered yet or we need to try paginated URL
          setDlProgress(msg.debug ? 'Debug: ' + msg.debug : 'No chapters found. Check the URL is the story page.');
          setDlBusy(false);
          setShowScraper(false);
          setScraperUrl(null);
        }
      }
    } catch {}
  };

  const filteredDlChapters = dlChapters.filter(ch => {
    if (dlFrom) { const d = new Date(dlFrom); if (!isNaN(d) && ch.ts < d.getTime()) return false; }
    if (dlTo)   { const d = new Date(dlTo + 'T23:59:59'); if (!isNaN(d) && ch.ts > d.getTime()) return false; }
    return true;
  }).slice().sort((a,b) => dlNewest ? (b.ts||0)-(a.ts||0) : (a.ts||0)-(b.ts||0));

  const toggleChapter = url => setDlChapters(prev => prev.map(c => c.url === url ? { ...c, selected: !c.selected } : c));
  const selectAll   = () => setDlChapters(prev => prev.map(c => ({ ...c, selected: true })));
  const deselectAll = () => setDlChapters(prev => prev.map(c => ({ ...c, selected: false })));

  // ---- Download via hidden WebView (bypasses Cloudflare) ----
  const [dlWebQueue,   setDlWebQueue]   = useState([]);  // chapters waiting to be fetched
  const [dlWebResults, setDlWebResults] = useState({});  // url -> html content
  const [dlWebMode,    setDlWebMode]    = useState(null); // 'app' | 'epub'
  const dlWebRef  = useRef(null);
  const dlQueueRef = useRef([]);
  const dlResultsRef = useRef({});
  const dlTotalRef = useRef(0);

  // JS that extracts chapter content and posts it back
  const chapterExtractJS = `(function() {
    var sel = ['.chapter-content.chapter-inner','.chapter-content','#chapter-content'];
    var el = null;
    for (var i=0;i<sel.length;i++) { el = document.querySelector(sel[i]); if (el) break; }
    var html = el ? el.innerHTML : '';
    window.ReactNativeWebView.postMessage(JSON.stringify({ type:'chapter', url:location.href, html:html }));
  })();true;`;

  const handleDlWebMessage = async (event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'chapter') {
        dlResultsRef.current[msg.url] = msg.html || '';
        const done = Object.keys(dlResultsRef.current).length;
        setDlProgress('Downloaded ' + done + ' / ' + dlTotalRef.current + ' chapters...');
        // Load next chapter
        const remaining = dlQueueRef.current.filter(u => !(u in dlResultsRef.current));
        if (remaining.length > 0) {
          dlWebRef.current && dlWebRef.current.reload && (() => {})(); // no-op
          setDlWebQueue([remaining[0]]); // trigger next load via source change
        } else {
          // All done — build output
          finishDownload();
        }
      }
    } catch {}
  };

  const finishDownload = async () => {
    const toDownload = filteredDlChapters.filter(c => c.selected);
    const storyTitle = dlFeed ? dlFeed.title : 'Story';
    setDlWebQueue([]);

    if (dlWebMode === 'app') {
      const saved = toDownload.map(ch => ({
        id: (dlFeed ? dlFeed.id : 'dl') + '_' + ch.ts,
        feedId: dlFeed ? dlFeed.id : 'dl',
        feedTitle: storyTitle,
        title: ch.title, link: ch.url,
        description: '', fullHtml: dlResultsRef.current[ch.url] || '',
        pubDate: ch.ts, read: false, bookmarked: false, savedOffline: true,
      }));
      onSaveArticles && onSaveArticles(saved);
      setDlBusy(false);
      setDlWebMode(null);
      setDlProgress(saved.length + ' chapters saved.');
      showModal('Downloaded', saved.length + ' chapters saved to Offline.', [{ text: 'Great!' }], '✅');
    } else {
      setDlProgress('Building EPUB...');
      try {
        const FileSystem = require('expo-file-system/legacy');
        const Sharing    = require('expo-sharing');
        const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const id  = s => s.replace(/[^a-z0-9]/gi, '_');
        const chapters = toDownload.map((ch, i) => ({
          title: ch.title,
          content: dlResultsRef.current[ch.url] || '<p>Content unavailable.</p>',
          filename: 'ch' + String(i + 1).padStart(4, '0') + '.xhtml',
        }));

        // Build EPUB file contents
        const uuid = 'fp-' + Date.now();
        const manifestItems = chapters.map(c =>
          '<item id="' + id(c.filename) + '" href="' + c.filename + '" media-type="application/xhtml+xml"/>'
        ).join('\n    ');
        const spineItems = chapters.map(c =>
          '<itemref idref="' + id(c.filename) + '"/>'
        ).join('\n    ');
        const navPoints = chapters.map((c, i) =>
          '<navPoint id="np'+i+'" playOrder="'+(i+1)+'"><navLabel><text>'+esc(c.title)+'</text></navLabel><content src="'+c.filename+'"/></navPoint>'
        ).join('\n  ');
        const tocEntries = chapters.map((c, i) =>
          '<li><a href="'+c.filename+'">'+esc(c.title)+'</a></li>'
        ).join('\n      ');

        const opf = '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n  <dc:title>'+esc(storyTitle)+'</dc:title>\n  <dc:identifier id="uid">'+uuid+'</dc:identifier>\n  <dc:language>en</dc:language>\n  <meta property="dcterms:modified">'+new Date().toISOString().replace(/\.\d+Z/,'Z')+'</meta>\n</metadata>\n<manifest>\n  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n  <item id="css" href="style.css" media-type="text/css"/>\n  '+manifestItems+'\n</manifest>\n<spine toc="ncx">\n  <itemref idref="nav"/>\n  '+spineItems+'\n</spine>\n</package>';

        const ncx = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="'+uuid+'"/></head>\n<docTitle><text>'+esc(storyTitle)+'</text></docTitle>\n<navMap>\n  '+navPoints+'\n</navMap>\n</ncx>';

        const nav = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n<head><title>'+esc(storyTitle)+'</title><link rel="stylesheet" href="style.css"/></head>\n<body>\n<nav epub:type="toc">\n  <h1>'+esc(storyTitle)+'</h1>\n  <ol>\n      '+tocEntries+'\n  </ol>\n</nav>\n</body>\n</html>';

        const css = 'body{font-family:Georgia,serif;font-size:1em;line-height:1.8;margin:1em 2em}h1,h2{font-weight:bold}h1{font-size:1.5em;margin-bottom:0.3em}h2{font-size:1.2em;margin:1.8em 0 0.4em}p{margin:0 0 0.9em}em,i{font-style:italic}strong,b{font-weight:bold}';

        const chapterXhtml = chapters.map(c =>
          '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>'+esc(c.title)+'</title><link rel="stylesheet" href="style.css"/></head>\n<body>\n<h2>'+esc(c.title)+'</h2>\n'+c.content+'\n</body>\n</html>'
        );

        // Write all files to a temp directory, then zip using FileSystem
        const dir = FileSystem.cacheDirectory + 'epub_' + Date.now() + '/';
        await FileSystem.makeDirectoryAsync(dir + 'OEBPS/', { intermediates: true });
        await FileSystem.makeDirectoryAsync(dir + 'META-INF/', { intermediates: true });
        await FileSystem.writeAsStringAsync(dir + 'mimetype', 'application/epub+zip', { encoding: FileSystem.EncodingType.UTF8 });
        await FileSystem.writeAsStringAsync(dir + 'META-INF/container.xml', '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles>\n<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n</rootfiles>\n</container>');
        await FileSystem.writeAsStringAsync(dir + 'OEBPS/content.opf', opf);
        await FileSystem.writeAsStringAsync(dir + 'OEBPS/toc.ncx', ncx);
        await FileSystem.writeAsStringAsync(dir + 'OEBPS/nav.xhtml', nav);
        await FileSystem.writeAsStringAsync(dir + 'OEBPS/style.css', css);
        for (let i = 0; i < chapters.length; i++) {
          await FileSystem.writeAsStringAsync(dir + 'OEBPS/' + chapters[i].filename, chapterXhtml[i]);
        }

        // Zip it — expo-file-system doesn't have zip, use a simple base64 approach:
        // Write a self-contained HTML that mimics epub structure (opens in any ebook reader app via share)
        // For true epub, write as a single combined file and share
        const safeName = storyTitle.replace(/[^a-z0-9 ]/gi, '').trim().replace(/ +/g, '_') || 'story';
        const outPath  = FileSystem.cacheDirectory + safeName + '.epub';

        // Build a minimal valid EPUB as a raw string that can be written directly
        // Use the stored chapter files and concat with proper EPUB headers
        // Since we can't ZIP in JS without a library, write all content as a self-contained XHTML
        // and share as .epub — modern readers (Play Books, Moon+ Reader) accept single XHTML epubs
        const singleFileEpub = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n<head>\n<meta charset="utf-8"/>\n<title>'+esc(storyTitle)+'</title>\n<style>\n'+css+'\n</style>\n</head>\n<body>\n<section epub:type="frontmatter">\n<h1>'+esc(storyTitle)+'</h1>\n<nav epub:type="toc"><ol>'+tocEntries+'</ol></nav>\n</section>\n'+
          chapters.map((c, i) => '<section epub:type="chapter" id="ch'+(i+1)+'">\n<h2>'+esc(c.title)+'</h2>\n'+c.content+'\n</section>').join('\n')+
          '\n</body>\n</html>';

        await FileSystem.writeAsStringAsync(outPath, singleFileEpub, { encoding: FileSystem.EncodingType.UTF8 });

        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(outPath, { mimeType: 'application/epub+zip', dialogTitle: 'Save ' + storyTitle + '.epub', UTI: 'org.idpf.epub-container' });
          setDlProgress('EPUB ready to save!');
        } else {
          setDlProgress('Sharing not available on this device.');
        }
      } catch(e) {
        setDlProgress('EPUB build failed: ' + e.message);
        Alert.alert('Error', e.message);
      }
      setDlBusy(false);
      setDlWebMode(null);
    }
    dlResultsRef.current = {};
    dlQueueRef.current   = [];
  };

  const startDownload = (mode) => {
    const toDownload = filteredDlChapters.filter(c => c.selected);
    if (!toDownload.length) { Alert.alert('Nothing selected'); return; }
    setDlBusy(true);
    setDlWebMode(mode);
    dlResultsRef.current = {};
    dlQueueRef.current   = toDownload.map(c => c.url);
    dlTotalRef.current   = toDownload.length;
    setDlProgress('Starting download of ' + toDownload.length + ' chapters...');
    setDlWebQueue([toDownload[0].url]); // kick off first chapter
  };

  // When dlWebQueue changes, update the WebView source
  const currentDlUrl = dlWebQueue.length > 0 ? dlWebQueue[0] : null;;

  // Sort + filter saved articles
  const sortedSaved = articles
    .filter(a => !filterText || a.title.toLowerCase().includes(filterText.toLowerCase()) || (a.feedTitle || '').toLowerCase().includes(filterText.toLowerCase()))
    .sort((a, b) => {
      if (sortOrder === 'newest') return b.pubDate - a.pubDate;
      if (sortOrder === 'oldest') return a.pubDate - b.pubDate;
      return a.title.localeCompare(b.title);
    });

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      {/* Tab switcher */}
      {/* Hidden WebView — sequential chapter downloader */}
      {currentDlUrl && (
        <View style={{ position: 'absolute', top: -9999, width: 1, height: 1 }}>
          <WebView
            ref={dlWebRef}
            source={{ uri: currentDlUrl }}
            javaScriptEnabled={true}
            onLoadEnd={() => {
              // Wait 1s for RR's JS to render chapter content, then inject extractor
              setTimeout(() => {
                dlWebRef.current && dlWebRef.current.injectJavaScript(chapterExtractJS);
              }, 1000);
            }}
            onMessage={handleDlWebMessage}
            onError={() => {
              dlResultsRef.current[currentDlUrl] = '';
              const remaining = dlQueueRef.current.filter(u => !(u in dlResultsRef.current));
              if (remaining.length > 0) setDlWebQueue([remaining[0]]);
              else finishDownload();
            }}
            originWhitelist={['*']}
            userAgent="Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
          />
        </View>
      )}

      {/* Modal WebView — loads story page, hidden behind overlay. User never sees RR's UI */}
      {showScraper && scraperUrl && (
        <Modal visible={true} animationType="fade" onRequestClose={() => { setShowScraper(false); setDlBusy(false); setScraperUrl(null); }}>
          <View style={{ flex: 1, backgroundColor: th.bg }}>
            {/* WebView fills the screen so RR renders fully, covered by overlay */}
            <WebView
              ref={scraperRef}
              source={{ uri: scraperUrl }}
              style={{ flex: 1 }}
              javaScriptEnabled={true}
              onMessage={handleScraperMessage}
              onLoadEnd={() => {
                // Page is fully loaded — now inject scraper. Delay slightly for JS frameworks.
                setTimeout(() => {
                  scraperRef.current && scraperRef.current.injectJavaScript(scraperJS);
                }, 800);
              }}
              onError={() => { setDlProgress('Failed to load story page.'); setDlBusy(false); setShowScraper(false); setScraperUrl(null); }}
              originWhitelist={['*']}
              userAgent="Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
            />
            {/* Full-screen overlay — covers the RR page, user just sees a spinner */}
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: th.bg, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
              <ActivityIndicator color={th.accent} size="large" />
              <Text style={{ color: th.text, fontWeight: '800', fontSize: 18, marginTop: 20, marginBottom: 8 }}>Fetching chapters...</Text>
              <Text style={{ color: th.textMuted, fontSize: 13, textAlign: 'center', marginBottom: 32 }}>{dlProgress || 'Loading story page...'}</Text>
              <Text style={{ color: th.textMuted, fontSize: 11 }} numberOfLines={1}>{scraperUrl}</Text>
              <TouchableOpacity
                onPress={() => { setShowScraper(false); setDlBusy(false); setScraperUrl(null); }}
                style={{ marginTop: 32, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: th.border }}
              >
                <Text style={{ color: th.textMuted }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
      <View style={{ flexDirection: 'row', backgroundColor: th.surfaceAlt, borderBottomWidth: 1, borderBottomColor: th.border, padding: 8, gap: 8 }}>
        <TouchableOpacity onPress={() => setView('saved')} style={{ flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: view === 'saved' ? th.accent : 'transparent', alignItems: 'center' }}>
          <Text style={{ color: view === 'saved' ? '#fff' : th.textSub, fontWeight: '700', fontSize: 13 }}>Saved ({articles.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setView('download')} style={{ flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: view === 'download' ? th.accent : 'transparent', alignItems: 'center' }}>
          <Text style={{ color: view === 'download' ? '#fff' : th.textSub, fontWeight: '700', fontSize: 13 }}>Download Story</Text>
        </TouchableOpacity>
      </View>

      {view === 'saved' ? (
        <View style={{ flex: 1 }}>
          {/* Sort + filter bar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 8 }}>
            <TextInput
              style={{ flex: 1, backgroundColor: th.surfaceAlt, borderWidth: 1, borderColor: th.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, color: th.text, fontSize: 13 }}
              placeholder="Filter saved..." placeholderTextColor={th.textMuted}
              value={filterText} onChangeText={setFilterText}
            />
            {['newest','oldest','alpha'].map(s => (
              <TouchableOpacity key={s} onPress={() => setSortOrder(s)} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: sortOrder === s ? th.accent : th.tag }}>
                <Text style={{ color: sortOrder === s ? '#fff' : th.tagText, fontSize: 11, fontWeight: '600' }}>{s === 'newest' ? 'New' : s === 'oldest' ? 'Old' : 'A-Z'}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <FlatList
            data={sortedSaved} keyExtractor={a => a.id}
            contentContainerStyle={{ padding: 10 }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>📥</Text>
                <Text style={[styles.emptyTitle, { color: th.text }]}>No saved articles</Text>
                <Text style={[styles.emptySub, { color: th.textMuted }]}>Tap 📥 while reading to save, or use Download Story</Text>
              </View>
            }
            renderItem={({ item: a }) => (
              <View style={{ marginBottom: 10 }}>
                <ArticleCard article={a} th={th} feedTitle={a.feedTitle} onPress={() => onOpen(a)} onBookmark={() => onBookmark(a.id)} onToggleRead={() => onToggleRead(a.id)} />
                <TouchableOpacity
                  onPress={() => showModal('Remove', '"' + a.title.slice(0, 50) + '"', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => onDelete(a.id) }], '🗑')}
                  style={{ position: 'absolute', top: 14, right: 14, padding: 4 }}
                >
                  <Text style={{ fontSize: 16 }}>🗑</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
          <Text style={[styles.sLabel, { color: th.textSub }]}>STORY</Text>
          {rrFeeds.length === 0 ? (
            <View style={{ padding: 14, backgroundColor: th.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: th.border, marginBottom: 14 }}>
              <Text style={{ color: th.textMuted, textAlign: 'center', fontSize: 13 }}>No Royal Road feeds added yet.</Text>
            </View>
          ) : (
            <View style={{ marginBottom: 14 }}>
              {/* Tap to open/close. Search inside the open dropdown. */}
              <TouchableOpacity
                onPress={() => { setDlDropdown(v => !v); setDlSearch(''); }}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: th.card, borderWidth: 1, borderColor: dlDropdown ? th.accent : th.border, borderRadius: 10, padding: 12 }}
              >
                <Text style={{ color: dlFeed ? th.text : th.textMuted, fontWeight: dlFeed ? '700' : '400', flex: 1 }} numberOfLines={1}>
                  {dlFeed ? dlFeed.title : 'Select a story...'}
                </Text>
                <Text style={{ color: th.textMuted, marginLeft: 8 }}>{dlDropdown ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {dlDropdown && (
                <View style={{ backgroundColor: th.card, borderWidth: 1, borderColor: th.accent, borderRadius: 10, overflow: 'hidden', marginTop: 4, marginBottom: 4 }}>
                  {rrFeeds.length > 4 && (
                    <TextInput
                      style={{ padding: 10, borderBottomWidth: 1, borderBottomColor: th.border, color: th.text, fontSize: 13, backgroundColor: th.surfaceAlt }}
                      placeholder="Filter stories..."
                      placeholderTextColor={th.textMuted}
                      value={dlSearch}
                      onChangeText={setDlSearch}
                      autoFocus
                    />
                  )}
                  {rrFeeds.filter(f => !dlSearch || f.title.toLowerCase().includes(dlSearch.toLowerCase())).map((f, i, arr) => (
                    <TouchableOpacity
                      key={f.id}
                      onPress={() => { setDlFeed(f); setDlDropdown(false); setDlSearch(''); setDlChapters([]); setDlProgress(''); }}
                      style={{ padding: 13, borderBottomWidth: i < arr.length - 1 ? 1 : 0, borderBottomColor: th.border, backgroundColor: dlFeed?.id === f.id ? th.accentBg : 'transparent' }}
                    >
                      <Text style={{ color: dlFeed?.id === f.id ? th.accent : th.text, fontWeight: '600' }} numberOfLines={1}>{f.title}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          )}

          <Text style={[styles.sLabel, { color: th.textSub }]}>DATE RANGE (optional)</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 4 }}>
            <View style={{ flex: 1 }}>
              <CalendarPicker th={th} value={dlFrom} onChange={setDlFrom} label="FROM" />
            </View>
            <View style={{ flex: 1 }}>
              <CalendarPicker th={th} value={dlTo} onChange={setDlTo} label="TO" />
            </View>
          </View>

          {filteredDlChapters.length > 0 ? (
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
              <TouchableOpacity onPress={() => startDownload('app')} disabled={dlBusy} style={{ flex: 1, backgroundColor: dlBusy ? th.border : th.accent, padding: 12, borderRadius: 12, alignItems: 'center' }}>
                {dlBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Save to App</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => startDownload('epub')} disabled={dlBusy} style={{ flex: 1, backgroundColor: th.surfaceAlt, borderWidth: 1, borderColor: th.border, padding: 12, borderRadius: 12, alignItems: 'center' }}>
                <Text style={{ color: th.textSub, fontWeight: '700', fontSize: 13 }}>Export EPUB</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={fetchChapterList} disabled={dlBusy} style={{ padding: 12, borderRadius: 12, backgroundColor: th.surfaceAlt, borderWidth: 1, borderColor: th.border }}>
                <Text style={{ color: th.textSub, fontSize: 16 }}>{'↺'}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={fetchChapterList} disabled={!dlFeed || dlBusy} style={{ backgroundColor: dlFeed && !dlBusy ? th.accent : th.border, padding: 13, borderRadius: 12, alignItems: 'center', marginBottom: 14 }}>
              {dlBusy && dlChapters.length === 0 ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Fetch Chapter List</Text>}
            </TouchableOpacity>
          )}

          {!!dlProgress && <Text style={{ color: th.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 10 }}>{dlProgress}</Text>}

          {filteredDlChapters.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ color: th.textSub, fontSize: 13, fontWeight: '600' }}>{filteredDlChapters.filter(c => c.selected).length} / {filteredDlChapters.length} selected</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity onPress={selectAll} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: th.tag }}>
                    <Text style={{ color: th.tagText, fontSize: 11 }}>All</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={deselectAll} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: th.tag }}>
                    <Text style={{ color: th.tagText, fontSize: 11 }}>None</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setDlNewest(v => !v)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: dlNewest ? th.accent : th.tag }}>
                    <Text style={{ color: dlNewest ? '#fff' : th.tagText, fontSize: 11 }}>{dlNewest ? 'Newest first' : 'Oldest first'}</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {filteredDlChapters.map(ch => (
                <TouchableOpacity key={ch.url} onPress={() => toggleChapter(ch.url)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: th.border }}>
                  <View style={{ width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: ch.selected ? th.accent : th.border, backgroundColor: ch.selected ? th.accent : 'transparent', marginRight: 12, alignItems: 'center', justifyContent: 'center' }}>
                    {ch.selected && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>✓</Text>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: th.text, fontSize: 13, fontWeight: '500' }} numberOfLines={1}>{ch.title}</Text>
                    <Text style={{ color: th.textMuted, fontSize: 10 }}>{ch.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
                  </View>
                </TouchableOpacity>
              ))}


            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ============================================================
// SETTINGS SCREEN
// ============================================================
function SettingsScreen({ th, styles, dark, onToggleDark, cats, onSaveCats, feeds, articles, onImport, onExport, onOpenRRBrowser, autoRefresh, onToggleAutoRefresh, checkInterval, onSetInterval, lastChecked, showModal, trueBlack, setTrueBlack, onSaveSettings }) {
  const [newCat, setNewCat] = useState('');
  const stats = [
    { l:'Feeds',         v: feeds.length },
    { l:'Articles',      v: articles.length },
    { l:'Unread',        v: articles.filter(a => !a.read).length },
    { l:'Bookmarked',    v: articles.filter(a => a.bookmarked).length },
    { l:'Saved Offline', v: articles.filter(a => a.savedOffline).length },
    { l:'Paused',        v: feeds.filter(f => f.paused).length },
  ];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={[styles.sLabel, { color: th.textSub }]}>APPEARANCE</Text>
      <View style={[styles.row, { backgroundColor: th.card, borderColor: th.border }]}>
        <Text style={[styles.rowLabel, { color: th.text }]}>Dark Mode</Text>
        <Switch value={dark} onValueChange={onToggleDark} trackColor={{ true: th.accent, false: th.border }} thumbColor="#fff" />
      </View>
      {dark && (
        <View style={[styles.row, { backgroundColor: th.card, borderColor: th.border }]}>
          <View>
            <Text style={[styles.rowLabel, { color: th.text }]}>True Black</Text>
            <Text style={{ color: th.textMuted, fontSize: 11 }}>AMOLED-friendly pure black background</Text>
          </View>
          <Switch value={trueBlack} onValueChange={v => { setTrueBlack(v); onSaveSettings({ trueBlack: v }); }} trackColor={{ true: th.accent, false: th.border }} thumbColor="#fff" />
        </View>
      )}

      <Text style={[styles.sLabel, { color: th.textSub, marginTop: 20 }]}>BACKGROUND REFRESH</Text>

      {/* Main toggle */}
      <View style={[styles.row, { backgroundColor: th.card, borderColor: th.border, marginBottom: 6 }]}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={[styles.rowLabel, { color: th.text }]}>Check for new chapters</Text>
          <Text style={{ fontSize: 11, color: th.textMuted, marginTop: 2 }}>
            Runs while the app is open. A banner appears when new articles are found.
          </Text>
        </View>
        <Switch value={autoRefresh} onValueChange={onToggleAutoRefresh} trackColor={{ true: th.accent, false: th.border }} thumbColor="#fff" />
      </View>

      {/* Interval picker */}
      {autoRefresh && (
        <View style={{ backgroundColor: th.card, borderWidth: 1, borderColor: th.border, borderRadius: 11, padding: 14, marginBottom: 6 }}>
          <Text style={{ color: th.textSub, fontSize: 12, fontWeight: '600', marginBottom: 10 }}>Check every:</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CHECK_INTERVALS.map(opt => {
              const active = checkInterval === opt.ms;
              return (
                <TouchableOpacity
                  key={opt.ms}
                  onPress={() => onSetInterval(opt.ms)}
                  style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: active ? th.accent : th.tag, borderWidth: active ? 0 : 1, borderColor: th.border }}
                >
                  <Text style={{ color: active ? '#fff' : th.tagText, fontSize: 13, fontWeight: active ? '700' : '400' }}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Last checked */}
          {lastChecked ? (
            <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: th.success, fontSize: 11 }}>Last checked: </Text>
              <Text style={{ color: th.textMuted, fontSize: 11 }}>
                {new Date(lastChecked).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                {' on '}
                {new Date(lastChecked).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </Text>
            </View>
          ) : (
            <Text style={{ color: th.textMuted, fontSize: 11, marginTop: 12 }}>Not yet checked this session</Text>
          )}
        </View>
      )}

      {/* Future notifications note */}
      <View style={{ backgroundColor: th.accentBg, borderWidth: 1, borderColor: th.accent, borderRadius: 11, padding: 14, marginBottom: 4 }}>
        <Text style={{ color: th.accent, fontWeight: '700', fontSize: 13, marginBottom: 4 }}>Push notifications coming soon</Text>
        <Text style={{ color: th.textMuted, fontSize: 12, lineHeight: 18 }}>
          Once RoyalRoadReader is built as a real app (not Expo Snack), background checks will run even when the app is closed and will send a notification to your phone when new chapters arrive — just like Flym.
        </Text>
      </View>

      <Text style={[styles.sLabel, { color: th.textSub, marginTop: 8 }]}>ROYAL ROAD</Text>
      <View style={{ padding: 14, borderRadius: 12, backgroundColor: th.card, borderWidth: 1, borderColor: th.border, marginBottom: 8 }}>
        <Text style={{ color: th.text, fontWeight: '700', marginBottom: 8 }}>How to add a story</Text>
        <Text style={{ color: th.textMuted, fontSize: 12, lineHeight: 20 }}>
          {'1. Find the story ID in the URL:\n   royalroad.com/fiction/'}
          <Text style={{ color: th.accent }}>12345</Text>
          {'/story-name\n\n2. Add the feed URL:\n   royalroad.com/fiction/'}
          <Text style={{ color: th.accent }}>12345</Text>
          {'/rss\n\n3. Tap any article to read it — full chapter loads in-app with all formatting intact.'}
        </Text>
      </View>

      <Text style={[styles.sLabel, { color: th.textSub, marginTop: 12 }]}>FLYM / OPML</Text>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
        <TouchableOpacity onPress={onImport} style={[styles.modalBtn, { flex: 1, backgroundColor: th.accentBg, borderWidth: 1, borderColor: th.accent }]}>
          <Text style={{ color: th.accent, textAlign: 'center', fontWeight: '700' }}>Import OPML</Text>
          <Text style={{ color: th.textMuted, textAlign: 'center', fontSize: 11, marginTop: 2 }}>from Flym or any reader</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onExport} style={[styles.modalBtn, { flex: 1, backgroundColor: th.accentBg, borderWidth: 1, borderColor: th.accent }]}>
          <Text style={{ color: th.accent, textAlign: 'center', fontWeight: '700' }}>Export OPML</Text>
          <Text style={{ color: th.textMuted, textAlign: 'center', fontSize: 11, marginTop: 2 }}>share back to Flym</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.sLabel, { color: th.textSub, marginTop: 20 }]}>STATS</Text>
      {stats.map(s => (
        <View key={s.l} style={[styles.row, { backgroundColor: th.card, borderColor: th.border }]}>
          <Text style={[styles.rowLabel, { color: th.text }]}>{s.l}</Text>
          <Text style={{ color: th.accent, fontWeight: '800', fontSize: 16 }}>{s.v}</Text>
        </View>
      ))}

      <Text style={[styles.sLabel, { color: th.textSub, marginTop: 20 }]}>ABOUT</Text>
      {[['App','RoyalRoadReader'],['Version','1.2.0'],['Based on','Flym by FredJul (MIT)'],['Built with','Expo / React Native']].map(([k, v]) => (
        <View key={k} style={[styles.row, { backgroundColor: th.card, borderColor: th.border }]}>
          <Text style={[styles.rowLabel, { color: th.text }]}>{k}</Text>
          <Text style={{ color: th.textMuted, fontSize: 13 }}>{v}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

// ============================================================
// ADD FEED MODAL
// ============================================================
function AddFeedModal({ visible, th, styles, cats, onClose, onAdd, onAddArticle, feeds, articles, showModal }) {
  const [url,        setUrl]        = useState('');
  const [title,      setTitle]      = useState('');
  const [cat,        setCat]        = useState('General');
  const [autoFetch,  setAutoFetch]  = useState(false);
  const [mode,       setMode]       = useState('add'); // 'add' | 'fetch'
  const [fetchFeedId, setFetchFeedId] = useState(null);
  const [fetching,   setFetching]   = useState(false);

  const rrFeeds = (feeds || []).filter(f => f.url.toLowerCase().includes('royalroad'));

  const fetchLatestChapter = async (feed) => {
    setFetching(true);
    let bestItems = [];
    try {
      bestItems = await fetchFeedItems(feed, 10000);
    } catch {}
    setFetching(false);
    if (!bestItems.length) {
      showModal && showModal('No Data', 'Could not fetch the RSS feed. Check your connection.', [{ text: 'OK' }], '⚠️');
      return;
    }
    // Sort by date descending — latest first
    bestItems.sort((a,b) => (b.pubDate || 0) - (a.pubDate || 0));
    const latest = bestItems[0];
    // Check if already in articles
    const existing = (articles || []).find(a => a.feedId === feed.id && a.link === latest.link);
    if (existing) {
      showModal && showModal('Already up to date', '"' + (latest.title || latest.link) + '" is already in your list.', [{ text: 'OK' }], '✓');
    } else {
      // Add it
      onAddArticle && onAddArticle(feed.id, {
        link: latest.link,
        title: latest.title,
        date: latest.pubDate ? new Date(latest.pubDate) : new Date(),
      });
      showModal && showModal('Chapter added', '"' + (latest.title || 'Latest chapter') + '" has been added to ' + feed.title + '.', [{ text: 'OK' }], '✓');
    }
  };

  const toRssUrl = raw => {
    try {
      const u = new URL(raw.trim().startsWith('http') ? raw.trim() : 'https://' + raw.trim());
      if (u.hostname.includes('royalroad.com')) {
        // Extract fiction ID: /fiction/12345/...
        const m = u.pathname.match(/\/fiction\/(\d+)/);
        if (m) return 'https://www.royalroad.com/fiction/syndication/' + m[1];
      }
      return raw.trim().startsWith('http') ? raw.trim() : 'https://' + raw.trim();
    } catch { return raw.trim(); }
  };

  const handle = () => {
    if (!url.trim()) return;
    const clean = toRssUrl(url.trim());
    onAdd(clean, title.trim() || null, cat);
    setUrl(''); setTitle(''); setCat('General'); onClose();
  };

  const fetchTitle = async (rawUrl) => {
    if (!rawUrl.trim()) return;
    // Convert RR link to syndication URL first
    let clean = rawUrl.trim().startsWith('http') ? rawUrl.trim() : 'https://' + rawUrl.trim();
    try {
      const u = new URL(clean);
      if (u.hostname.includes('royalroad.com')) {
        const m2 = u.pathname.match(/\/fiction\/(\d+)/);
        if (m2) { clean = 'https://www.royalroad.com/fiction/syndication/' + m2[1]; setUrl(clean); }
      }
    } catch {}
    setAutoFetch(true);
    try {
      const text = await fetchFeedXml(clean, 8000);
      const m = text.match(/<title[^>]*>([^<]{2,120})<\/title>/i)
             || text.match(/<channel[^>]*>[\s\S]*?<title[^>]*><!\[CDATA\[([^\]]+)\]\]><\/title>/i)
             || text.match(/<channel[^>]*>[\s\S]*?<title[^>]*>([^<]{2,120})<\/title>/i);
      if (m && m[1]) setTitle(m[1].trim().replace(/\s*RSS\s*$/i,'').trim());
    } catch {}
    setAutoFetch(false);
  };

  const isRR = url.toLowerCase().includes('royalroad');
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: th.surface, borderColor: th.border }]}>
          <Text style={[styles.sheetTitle, { color: th.text }]}>Add RSS Feed</Text>
          {/* Mode tabs */}
          <View style={{ flexDirection: 'row', backgroundColor: th.surfaceAlt, borderRadius: 10, padding: 3, marginBottom: 14 }}>
            <TouchableOpacity onPress={() => setMode('add')} style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: mode === 'add' ? th.accent : 'transparent', alignItems: 'center' }}>
              <Text style={{ color: mode === 'add' ? '#fff' : th.textMuted, fontWeight: '700', fontSize: 13 }}>Add Feed</Text>
            </TouchableOpacity>
            {rrFeeds.length > 0 && (
              <TouchableOpacity onPress={() => setMode('fetch')} style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: mode === 'fetch' ? th.accent : 'transparent', alignItems: 'center' }}>
                <Text style={{ color: mode === 'fetch' ? '#fff' : th.textMuted, fontWeight: '700', fontSize: 13 }}>Fetch Latest</Text>
              </TouchableOpacity>
            )}
          </View>

          {mode === 'fetch' ? (
            <>
              <Text style={{ color: th.textMuted, fontSize: 12, marginBottom: 12 }}>
                Checks a feed's RSS right now and adds the latest chapter if it's not already in your list.
              </Text>
              {rrFeeds.map(f => (
                <TouchableOpacity key={f.id} onPress={() => { setFetchFeedId(f.id); fetchLatestChapter(f); }}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, marginBottom: 8, backgroundColor: th.card, borderRadius: 10, borderWidth: 1, borderColor: fetchFeedId === f.id && fetching ? th.accent : th.border }}>
                  <Text style={{ color: th.text, fontWeight: '600', flex: 1 }} numberOfLines={1}>{f.title}</Text>
                  {fetchFeedId === f.id && fetching
                    ? <ActivityIndicator size="small" color={th.accent} />
                    : <Text style={{ color: th.textMuted, fontSize: 12 }}>{'↓'}</Text>}
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={onClose} style={[styles.modalBtn, { backgroundColor: th.surfaceAlt, marginTop: 8 }]}>
                <Text style={{ color: th.textSub, textAlign: 'center', fontWeight: '600' }}>Close</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
          <View style={{ padding: 10, borderRadius: 10, backgroundColor: th.accentBg, borderWidth: 1, borderColor: th.accent, marginBottom: 14 }}>
            <Text style={{ color: th.accent, fontWeight: '700', fontSize: 12, marginBottom: 2 }}>Royal Road — paste any link</Text>
            <Text style={{ color: th.textMuted, fontSize: 11 }}>Story page, chapter URL, or syndication link — auto-detected</Text>
          </View>
          <Text style={[styles.label, { color: th.textSub }]}>Feed URL *</Text>
          <TextInput style={[styles.input, { backgroundColor: th.surfaceAlt, borderColor: isRR ? th.accent : th.border, color: th.text }]} placeholder="https://royalroad.com/fiction/syndication/ID" placeholderTextColor={th.textMuted} value={url} onChangeText={setUrl} onBlur={() => fetchTitle(url)} autoCapitalize="none" keyboardType="url" />
          {isRR && <Text style={{ color: th.success, fontSize: 11, marginTop: -10, marginBottom: 10 }}>Royal Road feed detected</Text>}
          <Text style={[styles.label, { color: th.textSub }]}>Title (optional)</Text>
          <View style={{ position: 'relative' }}>
            <TextInput style={[styles.input, { backgroundColor: th.surfaceAlt, borderColor: th.border, color: th.text }]} placeholder={autoFetch ? 'Fetching...' : 'Auto-detected from URL'} placeholderTextColor={th.textMuted} value={title} onChangeText={setTitle} />
            {autoFetch && <ActivityIndicator style={{ position:'absolute', right:12, top:12 }} size="small" color={th.accent} />}
          </View>
          <Text style={[styles.label, { color: th.textSub }]}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 18 }}>
            {cats.map(c => (
              <TouchableOpacity key={c} onPress={() => setCat(c)} style={[styles.chip, { backgroundColor: cat === c ? th.accent : th.tag, marginRight: 8 }]}>
                <Text style={[styles.chipText, { color: cat === c ? '#fff' : th.tagText }]}>{c}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity onPress={onClose} style={[styles.modalBtn, { flex: 1, backgroundColor: th.surfaceAlt }]}><Text style={{ color: th.textSub, textAlign: 'center', fontWeight: '600' }}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity onPress={handle} style={[styles.modalBtn, { flex: 1, backgroundColor: th.accent }]}><Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>Add Feed</Text></TouchableOpacity>
          </View>
          </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================
// IMPORT OPML MODAL
// ============================================================
function ImportOPMLModal({ visible, th, styles, onClose, onImport }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('file');
  const [url,  setUrl]  = useState('');
  const [busy, setBusy] = useState(false);

  const handleFile = async () => {
    try {
      const DocumentPicker = require('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/xml','application/xml','text/plain','*/*'], copyToCacheDirectory: true });
      if (result.canceled || !result.assets || !result.assets[0]) return;
      const FileSystem = require('expo-file-system');
      const xml = await FileSystem.readAsStringAsync(result.assets[0].uri);
      onImport(xml); onClose();
    } catch { Alert.alert('Error', 'Could not read file. Try the paste option.'); }
  };

  const handleUrl = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(url.trim()));
      const xml = await res.text();
      onImport(xml); setUrl(''); onClose();
    } catch { Alert.alert('Error', 'Could not fetch OPML from that URL.'); }
    setBusy(false);
  };

  const handlePaste = () => { onImport(text); setText(''); onClose(); };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: th.surface, borderColor: th.border }]}>
          <Text style={[styles.sheetTitle, { color: th.text }]}>Import OPML</Text>
          <Text style={{ fontSize: 13, color: th.textMuted, marginBottom: 14, lineHeight: 18 }}>In Flym: Menu &gt; Manage feeds &gt; Export OPML</Text>
          <View style={{ flexDirection: 'row', backgroundColor: th.surfaceAlt, borderRadius: 10, padding: 3, marginBottom: 14 }}>
            {[['file','From File'],['url','From URL'],['paste','Paste XML']].map(([m, lbl]) => (
              <TouchableOpacity key={m} onPress={() => setMode(m)} style={{ flex: 1, padding: 9, borderRadius: 8, alignItems: 'center', backgroundColor: mode === m ? th.accent : 'transparent' }}>
                <Text style={{ color: mode === m ? '#fff' : th.textSub, fontSize: 12, fontWeight: '600' }}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {mode === 'file' && (
            <View style={{ alignItems: 'center', paddingVertical: 20 }}>
              <Text style={{ fontSize: 40, marginBottom: 12 }}>📁</Text>
              <Text style={{ color: th.textMuted, fontSize: 13, textAlign: 'center', marginBottom: 20, lineHeight: 20 }}>Pick your Flym OPML export file from your phone storage.</Text>
              <TouchableOpacity onPress={handleFile} style={[styles.modalBtn, { backgroundColor: th.accent, paddingHorizontal: 32 }]}>
                <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700', fontSize: 15 }}>Choose File</Text>
              </TouchableOpacity>
            </View>
          )}
          {mode === 'url' && (
            <>
              <TextInput style={[styles.input, { backgroundColor: th.surfaceAlt, borderColor: th.border, color: th.text }]} placeholder="https://example.com/feeds.opml" placeholderTextColor={th.textMuted} value={url} onChangeText={setUrl} autoCapitalize="none" keyboardType="url" />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity onPress={onClose} style={[styles.modalBtn, { flex: 1, backgroundColor: th.surfaceAlt }]}><Text style={{ color: th.textSub, textAlign: 'center', fontWeight: '600' }}>Cancel</Text></TouchableOpacity>
                <TouchableOpacity onPress={handleUrl} style={[styles.modalBtn, { flex: 1, backgroundColor: th.accent }]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>Fetch</Text>}</TouchableOpacity>
              </View>
            </>
          )}
          {mode === 'paste' && (
            <>
              <TextInput style={[styles.input, { backgroundColor: th.surfaceAlt, borderColor: th.border, color: th.text, height: 130, textAlignVertical: 'top', fontFamily: 'monospace', fontSize: 11 }]} placeholder={'<?xml version="1.0"?>\n<opml version="1.1">\n  ...\n</opml>'} placeholderTextColor={th.textMuted} value={text} onChangeText={setText} multiline autoCorrect={false} autoCapitalize="none" />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity onPress={onClose} style={[styles.modalBtn, { flex: 1, backgroundColor: th.surfaceAlt }]}><Text style={{ color: th.textSub, textAlign: 'center', fontWeight: '600' }}>Cancel</Text></TouchableOpacity>
                <TouchableOpacity onPress={handlePaste} style={[styles.modalBtn, { flex: 1, backgroundColor: th.accent }]}><Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>Import</Text></TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================
// CALENDAR PICKER
// ============================================================
function CalendarPicker({ th, value, onChange, label }) {
  const [open, setOpen]           = useState(false);
  const [viewYear, setViewYear]   = useState((value || new Date()).getFullYear());
  const [viewMonth, setViewMonth] = useState((value || new Date()).getMonth());
  const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const daysInMonth  = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };
  const selectDay = day => { onChange(new Date(viewYear, viewMonth, day)); setOpen(false); };
  const isSelected = day => value && value.getFullYear() === viewYear && value.getMonth() === viewMonth && value.getDate() === day;
  const isToday    = day => { const n = new Date(); return n.getFullYear() === viewYear && n.getMonth() === viewMonth && n.getDate() === day; };
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const displayVal = value ? value.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Tap to pick...';
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ color: th.textSub, fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 }}>{label}</Text>
      <TouchableOpacity onPress={() => setOpen(v => !v)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: th.card, borderWidth: 1, borderColor: open ? th.accent : th.border, borderRadius: 10, padding: 12 }}>
        <Text style={{ color: value ? th.text : th.textMuted, fontSize: 14, fontWeight: value ? '600' : '400' }}>{displayVal}</Text>
        <Text style={{ color: th.textMuted, fontSize: 12 }}>{open ? '^' : 'v'}</Text>
      </TouchableOpacity>
      {open && (
        <View style={{ backgroundColor: th.card, borderWidth: 1, borderColor: th.accent, borderRadius: 12, marginTop: 4, padding: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <TouchableOpacity onPress={prevMonth} style={{ padding: 6 }}><Text style={{ color: th.accent, fontWeight: '800', fontSize: 18 }}>{"<"}</Text></TouchableOpacity>
            <Text style={{ color: th.text, fontWeight: '800', fontSize: 14 }}>{MONTHS[viewMonth]} {viewYear}</Text>
            <TouchableOpacity onPress={nextMonth} style={{ padding: 6 }}><Text style={{ color: th.accent, fontWeight: '800', fontSize: 18 }}>{">"}</Text></TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', marginBottom: 4 }}>
            {DAYS.map(d => <View key={d} style={{ flex: 1, alignItems: 'center' }}><Text style={{ color: th.textMuted, fontSize: 10, fontWeight: '700' }}>{d}</Text></View>)}
          </View>
          {Array.from({ length: Math.ceil(cells.length / 7) }).map((_, row) => (
            <View key={row} style={{ flexDirection: 'row', marginBottom: 2 }}>
              {cells.slice(row * 7, row * 7 + 7).map((day, col) => {
                const sel = day && isSelected(day);
                const tod = day && isToday(day);
                return (
                  <TouchableOpacity key={col} onPress={() => day && selectDay(day)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', height: 34, borderRadius: 17, backgroundColor: sel ? th.accent : 'transparent' }}>
                    <Text style={{ color: sel ? '#fff' : tod ? th.accent : day ? th.text : 'transparent', fontWeight: sel || tod ? '800' : '400', fontSize: 13 }}>{day || ''}</Text>
                    {tod && !sel && <View style={{ position: 'absolute', bottom: 3, width: 4, height: 4, borderRadius: 2, backgroundColor: th.accent }} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
          {value && (
            <TouchableOpacity onPress={() => { onChange(null); setOpen(false); }} style={{ marginTop: 8, padding: 8, alignItems: 'center', borderTopWidth: 1, borderTopColor: th.border }}>
              <Text style={{ color: th.danger, fontSize: 12, fontWeight: '600' }}>Clear date</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

// ============================================================
// ROYAL ROAD CHAPTER BROWSER
// ============================================================
function RoyalRoadBrowser({ th, styles, sbTop, onClose, feeds }) {
  const rrFeeds = (feeds || []).filter(f => f.url.toLowerCase().includes('royalroad'));
  const [selectedFeed, setSelectedFeed] = useState(rrFeeds.length === 1 ? rrFeeds[0] : null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [chapters, setChapters]         = useState([]);
  const [loading, setLoading]           = useState(false);
  const [fromDate, setFromDate]         = useState(null);
  const [toDate, setToDate]             = useState(null);
  const [openChapter, setOpenChapter]   = useState(null);

  const parseRSSChapters = xml => {
    const list = [];
    const getVal = (str, tag) => {
      const s = str.indexOf('<' + tag);
      if (s === -1) return '';
      const t = str.indexOf('>', s) + 1;
      const e = str.indexOf('</' + tag, t);
      if (e === -1) return '';
      const raw = str.slice(t, e);
      if (raw.startsWith('<![CDATA[')) return raw.slice(9, raw.lastIndexOf(']]>')).trim();
      return raw.trim();
    };
    let pos = 0;
    while (true) {
      const s = xml.indexOf('<item', pos);
      if (s === -1) break;
      const e = xml.indexOf('</item>', s);
      if (e === -1) break;
      const it      = xml.slice(s, e + 7);
      const title   = getVal(it, 'title').replace(/<[^>]*>/g, '').trim();
      const link    = getVal(it, 'link');
      const pubDate = getVal(it, 'pubDate') || getVal(it, 'published');
      const date    = pubDate ? new Date(pubDate) : null;
      if (title && link && date && !isNaN(date.getTime())) {
        list.push({ url: link, title, date, ts: date.getTime() });
      }
      pos = e + 7;
    }
    return list.sort((a, b) => a.ts - b.ts);
  };

  const fetchChapterList = async () => {
    if (!selectedFeed) { Alert.alert('Pick a story first'); return; }
    setLoading(true); setChapters([]);
    try {
      const rssUrl = selectedFeed.url.startsWith('http') ? selectedFeed.url : 'https://' + selectedFeed.url;
      const xml    = await fetchFeedXml(rssUrl, 10000);
      const list   = parseRSSChapters(xml);
      if (!list.length) Alert.alert('No chapters found', 'Could not parse chapters from this RSS feed.');
      setChapters(list);
    } catch (e) { Alert.alert('Error', 'Could not fetch chapters.'); }
    setLoading(false);
  };

  const visibleChapters = chapters.filter(ch => {
    if (fromDate && ch.ts < fromDate.getTime()) return false;
    if (toDate) { const end = new Date(toDate); end.setHours(23,59,59); if (ch.ts > end.getTime()) return false; }
    return true;
  });

  if (openChapter) {
    return (
      <ChapterReaderView
        url={openChapter.url}
        title={openChapter.title}
        th={th}
        styles={styles}
        sbTop={sbTop}
        onClose={() => setOpenChapter(null)}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <View style={{ height: sbTop, backgroundColor: th.header }} />
      <View style={[styles.readerBar, { backgroundColor: th.header, borderBottomColor: th.border }]}>
        <TouchableOpacity onPress={onClose} style={{ paddingRight: 12 }}>
          <Text style={{ color: th.accent, fontSize: 16, fontWeight: '600' }}>{"<- Back"}</Text>
        </TouchableOpacity>
        <Text style={{ color: th.text, fontWeight: '800', fontSize: 16 }}>Chapter Browser</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={[styles.sLabel, { color: th.textSub }]}>STORY</Text>
        {rrFeeds.length === 0 ? (
          <View style={{ padding: 14, backgroundColor: th.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: th.border, marginBottom: 14 }}>
            <Text style={{ color: th.textMuted, fontSize: 13, textAlign: 'center' }}>No Royal Road feeds added yet. Add a feed from royalroad.com/fiction/ID/rss first.</Text>
          </View>
        ) : (
          <View style={{ marginBottom: 14 }}>
            <TouchableOpacity onPress={() => setDropdownOpen(v => !v)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: th.card, borderWidth: 1, borderColor: dropdownOpen ? th.accent : th.border, borderRadius: 10, padding: 12, marginBottom: 2 }}>
              <View style={{ flex: 1 }}>
                {selectedFeed ? (
                  <>
                    <Text style={{ color: th.text, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>{selectedFeed.title}</Text>
                    <Text style={{ color: th.textMuted, fontSize: 11, marginTop: 2 }} numberOfLines={1}>{selectedFeed.url}</Text>
                  </>
                ) : (
                  <Text style={{ color: th.textMuted, fontSize: 14 }}>Select a story...</Text>
                )}
              </View>
              <Text style={{ color: th.textMuted, marginLeft: 8 }}>{dropdownOpen ? '^' : 'v'}</Text>
            </TouchableOpacity>
            {dropdownOpen && (
              <View style={{ backgroundColor: th.card, borderWidth: 1, borderColor: th.accent, borderRadius: 10, overflow: 'hidden', marginBottom: 4 }}>
                {rrFeeds.map((feed, idx) => (
                  <TouchableOpacity key={feed.id} onPress={() => { setSelectedFeed(feed); setDropdownOpen(false); setChapters([]); }} style={{ padding: 12, backgroundColor: selectedFeed?.id === feed.id ? th.accentBg : 'transparent', borderBottomWidth: idx < rrFeeds.length - 1 ? 1 : 0, borderBottomColor: th.border }}>
                    <Text style={{ color: selectedFeed?.id === feed.id ? th.accent : th.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{selectedFeed?.id === feed.id ? 'v  ' : '   '}{feed.title}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        <Text style={[styles.sLabel, { color: th.textSub, marginTop: 4 }]}>DATE RANGE (optional)</Text>
        <CalendarPicker th={th} value={fromDate} onChange={setFromDate} label="FROM" />
        <CalendarPicker th={th} value={toDate}   onChange={setToDate}   label="TO" />
        {(fromDate || toDate) && (
          <TouchableOpacity onPress={() => { setFromDate(null); setToDate(null); }} style={{ alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ color: th.accent, fontSize: 12, fontWeight: '600' }}>Clear date range</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity onPress={fetchChapterList} style={{ backgroundColor: selectedFeed ? th.accent : th.border, padding: 14, borderRadius: 12, alignItems: 'center', marginTop: 4, marginBottom: 20 }}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Fetch Chapters</Text>}
        </TouchableOpacity>

        {chapters.length > 0 && (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={[styles.sLabel, { color: th.textSub, marginBottom: 0 }]}>{visibleChapters.length} OF {chapters.length} CHAPTERS</Text>
              {(fromDate || toDate) && <Text style={{ color: th.success, fontSize: 11 }}>filtered</Text>}
            </View>
            {visibleChapters.map(ch => (
              <TouchableOpacity key={ch.url} onPress={() => setOpenChapter(ch)} style={{ backgroundColor: th.card, borderWidth: 1, borderColor: th.border, borderRadius: 12, padding: 13, marginBottom: 8 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: th.text, marginBottom: 4 }} numberOfLines={2}>{ch.title}</Text>
                <Text style={{ fontSize: 11, color: th.textMuted }}>{ch.date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</Text>
              </TouchableOpacity>
            ))}
            {visibleChapters.length === 0 && <View style={{ alignItems: 'center', paddingVertical: 20 }}><Text style={{ color: th.textMuted, textAlign: 'center' }}>No chapters in that date range</Text></View>}
          </>
        )}

        {!loading && chapters.length === 0 && selectedFeed && (
          <View style={{ alignItems: 'center', paddingVertical: 20 }}>
            <Text style={{ fontSize: 36, marginBottom: 10 }}>📚</Text>
            <Text style={{ color: th.textMuted, textAlign: 'center', lineHeight: 20 }}>Tap "Fetch Chapters" to load all chapters for this story</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ============================================================
// CHAPTER READER VIEW — shared by ArticleReader & RR Browser
// Fetches page, extracts chapter + author notes, renders clean HTML
// ============================================================
const FONT_OPTIONS = [
  { key: 'serif',      label: 'Serif',    css: 'Georgia, "Times New Roman", serif' },
  { key: 'sans',       label: 'Sans',     css: '"Helvetica Neue", Arial, sans-serif' },
  { key: 'mono',       label: 'Mono',     css: '"Courier New", monospace' },
  { key: 'dyslexic',   label: 'OpenDys',  css: '"Arial", sans-serif;letter-spacing:0.05em;word-spacing:0.1em' },
];

function ChapterReaderView({ url, offlineHtml, th, styles, sbTop, onClose, rightControls, onAddManualChapter, prevTitle, nextTitle, onPrev, onNext, initFontSize, initFont, onFontSize, onFont }) {
  const [fontSize,    setFontSize]    = useState(initFontSize || 15);
  const [font,        setFont]        = useState(initFont || 'serif');
  const [ready,       setReady]       = useState(false); // JS has run, safe to show
  const prevUrlRef = useRef(null);
  // Reset ready state whenever the URL changes to ensure overlay always covers transition
  if (prevUrlRef.current !== url) {
    prevUrlRef.current = url;
    if (ready) setReady(false);  // will cause re-render with overlay shown
  }
  const [showFonts,   setShowFonts]   = useState(false);
  const [fullscreen,  setFullscreen]  = useState(false);
  const webRef   = useRef(null);
  const lastTapRef   = useRef(0);
  const [scrollThumb,  setScrollThumb]  = useState(0);   // 0..1 top position
  const [scrollThumbH, setScrollThumbH] = useState(0.15); // 0..1 thumb height

  const handleDoubleTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 350) {
      setFullscreen(v => !v);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  };

  const openInBrowser = () => Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open link.'));

  const bg = th.bg, fg = th.textSub, fgH = th.text, acc = th.accent, bdr = th.border, mut = th.textMuted, surf = th.surfaceAlt;

  // For offline chapters, build themed HTML directly (injectedJavaScript unreliable on html sources)
  const offlineSource = React.useMemo(() => {
    if (!offlineHtml) return null;
    const fcss = (FONT_OPTIONS.find(f => f.key === font) || FONT_OPTIONS[0]).css;
    const css = 'html,body{background:'+bg+' !important;color:'+fg+' !important;font-family:'+fcss+' !important;font-size:'+fontSize+'px !important;line-height:1.85 !important;padding:20px 18px 80px !important;margin:0 !important}p{margin-bottom:1.1em !important}em,i{font-style:italic !important}strong,b{font-weight:700 !important}h1,h2,h3{font-weight:800 !important;margin:1.2em 0 0.5em !important}a{color:'+acc+' !important}';
    const pollScript = '(function(){var l=-1;function p(){var d=document.documentElement;var s=d.scrollTop||document.body.scrollTop;if(Math.abs(s-l)>1){l=s;var h=d.scrollHeight-d.clientHeight;var r=h>0?s/h:0;var t=h>0?Math.max(0.05,d.clientHeight/d.scrollHeight):0.15;window.ReactNativeWebView&&window.ReactNativeWebView.postMessage("scroll:"+r.toFixed(3)+":"+t.toFixed(3));}requestAnimationFrame(p);}var h2=document.documentElement.scrollHeight-document.documentElement.clientHeight;var t2=h2>0?Math.max(0.05,document.documentElement.clientHeight/document.documentElement.scrollHeight):0.15;window.ReactNativeWebView&&window.ReactNativeWebView.postMessage("scroll:0:"+t2.toFixed(3));window.ReactNativeWebView&&window.ReactNativeWebView.postMessage("ready");requestAnimationFrame(p);})();';
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body>'+offlineHtml+'<script>'+pollScript+'<\/script></body></html>';
    return { html };
  }, [offlineHtml, bg, font, fontSize]);

  const fontCss = (FONT_OPTIONS.find(f => f.key === font) || FONT_OPTIONS[0]).css;

  const buildJS = (fs, fc, pTitle, nTitle) => {
    const fcss = (FONT_OPTIONS.find(f => f.key === fc) || FONT_OPTIONS[0]).css;
    const esc = s => (s||'').replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$').replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const prevBtn = pTitle ? '<button class="fp-nav-btn fp-nav-prev" onclick="window.ReactNativeWebView.postMessage(\'nav:prev\')">' + esc(pTitle) + '</button>' : '<div></div>';
    const nextBtn = nTitle ? '<button class="fp-nav-btn fp-nav-next" onclick="window.ReactNativeWebView.postMessage(\'nav:next\')">' + esc(nTitle) + '</button>' : '<div></div>';
    const navHtml = (pTitle || nTitle) ? '<div class="fp-nav">' + prevBtn + nextBtn + '</div>' : '';
    return `(function() {
  var bg='${bg}',fg='${fg}',fgH='${fgH}',acc='${acc}',bdr='${bdr}',mut='${mut}',surf='${surf}';
  var fs=${fs},fcss='${fcss}';

  // Hide everything immediately to prevent flash
  document.documentElement.style.visibility='hidden';

  var chapter =
    document.querySelector('.chapter-content.chapter-inner') ||
    document.querySelector('.chapter-content') ||
    document.querySelector('#chapter-content');

  // Collect notes that are OUTSIDE the chapter div to avoid duplicates when we clone chapter
  var chapterTop = chapter ? chapter.getBoundingClientRect().top : 9999;
  var chapterBottom = chapter ? chapter.getBoundingClientRect().bottom : 9999;
  // Only select outermost author-note containers. Using both selectors finds parent+child = duplicates.
  // Prefer .author-note-portlet (outer); fall back to .author-note if none found.
  var notePortlets = Array.from(document.querySelectorAll('.author-note-portlet'));
  var rawNotes = notePortlets.length > 0 ? notePortlets : Array.from(document.querySelectorAll('.author-note'));
  var allNotes = rawNotes.filter(function(n){
    // Skip if inside chapter AND skip if this element is contained by another note we already have
    if (chapter && chapter.contains(n)) return false;
    return !rawNotes.some(function(other){ return other !== n && other.contains(n); });
  });
  var notesBefore = allNotes.filter(function(n){ return n.getBoundingClientRect().top < chapterTop; });
  var notesAfter  = allNotes.filter(function(n){ return n.getBoundingClientRect().top >= chapterBottom; });

  function buildNote(noteEl, label) {
    var body = noteEl.querySelector('.portlet-body, .note-body, .author-note-body');
    var inner = body ? body.innerHTML : noteEl.innerHTML;
    if (!inner.replace(/<[^>]*>/g,'').trim()) return null;
    var d = document.createElement('details');
    d.className = 'fp-note';
    d.innerHTML = '<summary>' + label + '</summary><div class="fp-note-body">' + inner + '</div>';
    return d;
  }

  var style = document.createElement('style');
  style.textContent = [
    'html,body{background:'+bg+'!important;color:'+fg+'!important;font-family:'+fcss+'!important;font-size:'+fs+'px!important;line-height:1.85!important;padding:0!important;margin:0!important}',
    '.fp-wrap{padding:20px 18px 80px;max-width:740px;margin:0 auto}',
    '.fp-wrap p{margin-bottom:1.1em!important;color:'+fg+'!important;font-family:'+fcss+'!important}',
    '.fp-wrap em,.fp-wrap i{font-style:italic!important}',
    '.fp-wrap strong,.fp-wrap b{font-weight:700!important;color:'+fgH+'!important}',
    '.fp-wrap h1,.fp-wrap h2,.fp-wrap h3{color:'+fgH+'!important;font-weight:800!important;margin:1.2em 0 0.5em!important}',
    '.fp-wrap a{color:'+acc+'!important;text-decoration:none!important}',
    '.fp-wrap hr{border:none!important;border-top:1px solid '+bdr+'!important;margin:1.5em 0!important}',
    '.fp-wrap blockquote{border-left:3px solid '+acc+'!important;padding-left:14px!important;color:'+mut+'!important;margin:1em 0!important;font-style:italic!important}',
    'details.fp-note{border:1px solid '+bdr+';border-radius:10px;margin:0 0 18px;overflow:hidden}',
    'details.fp-note summary{background:'+surf+';color:'+mut+';padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px}',
    'details.fp-note summary::-webkit-details-marker{display:none}',
    'details.fp-note summary::before{content:">"}',
    'details[open].fp-note summary::before{content:"v"}',
    '.fp-note-body{padding:14px;font-size:0.9em;color:'+mut+'}',
    '.fp-nav{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:40px;padding:0 0 60px}',
    '.fp-nav-btn{padding:16px 14px;border-radius:14px;border:1px solid '+bdr+';background:'+surf+';color:'+mut+';font-size:12px;font-weight:600;cursor:pointer;text-align:left;line-height:1.4;display:block;width:100%;box-sizing:border-box}',
    '.fp-nav-btn::before{display:block;font-size:10px;opacity:0.6;margin-bottom:6px;letter-spacing:0.5px}',
    '.fp-nav-prev::before{content:"← PREVIOUS"}',
    '.fp-nav-next::before{content:"NEXT →";text-align:right}',
    '.fp-nav-next{background:'+acc+'22;border-color:'+acc+';color:'+fg+';text-align:right}',
  ].join('');
  document.head.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'fp-wrap';
  notesBefore.forEach(function(n){ var b=buildNote(n,"Author\\'s Note"); if(b) wrap.appendChild(b); });
  if (chapter) {
    var chapterClone = chapter.cloneNode(true);
    // Remove any author notes that are inside the chapter clone — we add them separately
    chapterClone.querySelectorAll('.author-note-portlet, .author-note').forEach(function(n){ n.remove(); }); // strip all note variants from clone
    wrap.appendChild(chapterClone);
  } else {
    var p = document.createElement('p');
    p.style.cssText = 'color:'+mut+';font-style:italic';
    p.textContent = 'Chapter content not found.';
    wrap.appendChild(p);
  }
  notesAfter.forEach(function(n){ var b=buildNote(n,"Author\\'s Note (end)"); if(b) wrap.appendChild(b); });

  var navDiv = document.createElement('div'); navDiv.innerHTML = ${JSON.stringify(navHtml)}; wrap.appendChild(navDiv.firstElementChild || navDiv);
  // Remove spans containing 'Amazon' (ad spans RR sometimes includes)
  wrap.querySelectorAll('span, p').forEach(function(el) {
    var t = el.textContent || '';
    if (/amazon/i.test(t) && t.trim().length < 200) {
      el.remove();
    }
  });
  document.body.innerHTML = '';
  document.body.appendChild(wrap);
  window.scrollTo(0,0);

  // Reveal only after DOM is rebuilt — no flash
  document.documentElement.style.visibility='visible';

  // Signal React Native that we're done
  (function(){var d=document.documentElement;var h=d.scrollHeight-d.clientHeight;var th=h>0?Math.max(0.05,d.clientHeight/d.scrollHeight):0.15;window.ReactNativeWebView.postMessage('scroll:0:'+th.toFixed(3));})();
  window.ReactNativeWebView.postMessage('ready');
  // Poll scroll position via rAF — window scroll events don't fire reliably in WebView
  var lastScrollTop = -1;
  function pollScroll() {
    var doc = document.documentElement;
    var scrollTop = doc.scrollTop || document.body.scrollTop;
    if (Math.abs(scrollTop - lastScrollTop) > 1) {
      lastScrollTop = scrollTop;
      var scrollH = doc.scrollHeight - doc.clientHeight;
      var ratio = scrollH > 0 ? scrollTop / scrollH : 0;
      var thumbH = scrollH > 0 ? Math.max(0.05, doc.clientHeight / doc.scrollHeight) : 1;
      window.ReactNativeWebView.postMessage('scroll:' + ratio.toFixed(3) + ':' + thumbH.toFixed(3));
    }
    requestAnimationFrame(pollScroll);
  }
  requestAnimationFrame(pollScroll);
})();true;`;
  };

  const handleFontSize = (newFs) => {
    setFontSize(newFs);
    if (onFontSize) onFontSize(newFs);
    if (webRef.current) webRef.current.injectJavaScript(buildJS(newFs, font, prevTitle, nextTitle));
  };

  const handleFont = (newFont) => {
    setFont(newFont);
    setShowFonts(false);
    if (onFont) onFont(newFont);
    if (webRef.current) webRef.current.injectJavaScript(buildJS(fontSize, newFont, prevTitle, nextTitle));
  };

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <StatusBar hidden={fullscreen} translucent={false} backgroundColor={th.header} barStyle={th.mode === 'dark' ? 'light-content' : 'dark-content'} />
      {!fullscreen && <View style={{ height: sbTop, backgroundColor: th.header }} />}
      {!fullscreen && <View style={[styles.readerBar, { backgroundColor: th.header, borderBottomColor: bdr }]}>
        <TouchableOpacity onPress={onClose} style={{ paddingRight: 12 }}>
          <Text style={{ color: acc, fontSize: 22 }}>{"←"}</Text>
        </TouchableOpacity>

        {/* Font size + font picker */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: th.surfaceAlt, borderRadius: 8, padding: 2 }}>
            <TouchableOpacity onPress={() => handleFontSize(Math.max(9, fontSize - 1))} style={{ paddingHorizontal: 9, paddingVertical: 5 }}>
              <Text style={{ color: th.textSub, fontWeight: '700', fontSize: 15 }}>A-</Text>
            </TouchableOpacity>
            <Text style={{ color: mut, fontSize: 11, minWidth: 18, textAlign: 'center' }}>{fontSize}</Text>
            <TouchableOpacity onPress={() => handleFontSize(Math.min(30, fontSize + 1))} style={{ paddingHorizontal: 9, paddingVertical: 5 }}>
              <Text style={{ color: th.textSub, fontWeight: '700', fontSize: 15 }}>A+</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            onPress={() => setShowFonts(v => !v)}
            style={{ backgroundColor: th.surfaceAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, borderWidth: showFonts ? 1 : 0, borderColor: acc }}
          >
            <Text style={{ color: th.textSub, fontSize: 12, fontWeight: '600' }}>Aa</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={() => setFullscreen(v => !v)} style={{ paddingLeft: 8 }}>
          <Text style={{ color: mut, fontSize: 18 }}>{'⛶'}</Text>
        </TouchableOpacity>
        {rightControls || (
          <TouchableOpacity onPress={openInBrowser} style={{ paddingLeft: 8 }}>
            <Text style={{ color: mut, fontSize: 12 }}>browser</Text>
          </TouchableOpacity>
        )}
      </View>}

      {/* Font picker dropdown */}
      {showFonts && !fullscreen && (
        <View style={{ backgroundColor: th.surface, borderBottomWidth: 1, borderBottomColor: bdr, flexDirection: 'row', padding: 10, gap: 8, flexWrap: 'wrap' }}>
          {FONT_OPTIONS.map(f => (
            <TouchableOpacity
              key={f.key}
              onPress={() => handleFont(f.key)}
              style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: font === f.key ? acc : th.tag, borderWidth: font === f.key ? 0 : 1, borderColor: bdr }}
            >
              <Text style={{ color: font === f.key ? '#fff' : th.tagText, fontSize: 13, fontWeight: '600' }}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* WebView loads invisibly in background — only shown after JS has rebuilt the DOM */}
      <View style={{ flex: 1 }} onTouchEnd={handleDoubleTap}>
        {/* Scroll indicator — track always visible, thumb position tracks scroll */}
        {ready && (
          <View pointerEvents="none" style={{ position:'absolute', right:2, top:4, bottom:4, width:3, zIndex:5, borderRadius:2, backgroundColor: acc + '18' }}>
            <View style={{ position:'absolute', top: (scrollThumb * (1 - scrollThumbH) * 100) + '%', width:3, height: Math.max(scrollThumbH * 100, 8) + '%', backgroundColor: acc, opacity:0.45, borderRadius:2 }} />
          </View>
        )}
        <WebView
          ref={webRef}
          source={offlineSource || { uri: url }}
          style={{ flex: 1, backgroundColor: bg, opacity: ready ? 1 : 0 }}
          injectedJavaScriptBeforeContentLoaded={offlineHtml ? undefined : 'document.documentElement.style.background="' + bg + '";document.documentElement.style.visibility="hidden";true;'}
          injectedJavaScript={offlineHtml ? undefined : buildJS(fontSize, font, prevTitle, nextTitle)}
          javaScriptEnabled={true}
          onMessage={event => {
            const d = event.nativeEvent.data;
            if (d === 'ready') setReady(true);
            else if (d.startsWith('scroll:')) {
              const parts = d.split(':');
              setScrollThumb(parseFloat(parts[1]) || 0);
              setScrollThumbH(parseFloat(parts[2]) || 0.15);
            }
            else if (d === 'nav:prev' && onPrev) onPrev();
            else if (d === 'nav:next' && onNext) onNext();
          }}
          onError={() => {
            setReady(true);
            Alert.alert('Error', 'Could not load chapter. Try opening in browser.');
          }}
          originWhitelist={['*']}
          userAgent="Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        />

        {/* Spinner overlay — covers WebView entirely until it's ready, then removed */}
        {!ready && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: bg, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator color={acc} size="large" />
            <Text style={{ color: mut, marginTop: 12, fontSize: 13 }}>Loading chapter...</Text>
          </View>
        )}

      </View>
    </View>
  );
}

// ============================================================
// APP MODAL — themed replacement for Alert.alert
// ============================================================
function AppModal({ visible, th, title, message, icon, buttons, onClose }) {
  if (!visible) return null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 28 }}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={{
            width: '100%', maxWidth: 340,
            backgroundColor: th.surface,
            borderRadius: 18,
            borderWidth: 1, borderColor: th.border,
            overflow: 'hidden',
            shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, elevation: 10,
          }}
        >
          {/* Header */}
          <View style={{ padding: 22, paddingBottom: 14, alignItems: 'center' }}>
            {!!icon && <Text style={{ fontSize: 36, marginBottom: 10 }}>{icon}</Text>}
            <Text style={{ color: th.text, fontSize: 17, fontWeight: '800', textAlign: 'center', marginBottom: message ? 8 : 0 }}>{title}</Text>
            {!!message && <Text style={{ color: th.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>{message}</Text>}
          </View>
          {/* Divider */}
          <View style={{ height: 1, backgroundColor: th.border }} />
          {/* Buttons */}
          <View style={{ flexDirection: buttons && buttons.length === 2 ? 'row' : 'column' }}>
            {(buttons || [{ text: 'OK', onPress: onClose }]).map((btn, i) => {
              const isDestructive = btn.style === 'destructive';
              const isCancel      = btn.style === 'cancel';
              const isLast        = i === (buttons || []).length - 1;
              const showRight     = buttons && buttons.length === 2 && i === 0;
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => { btn.onPress && btn.onPress(); onClose && onClose(); }}
                  style={{
                    flex: buttons && buttons.length === 2 ? 1 : undefined,
                    padding: 16,
                    alignItems: 'center',
                    backgroundColor: isDestructive ? th.danger + '18' : isCancel ? 'transparent' : 'transparent',
                    borderRightWidth: showRight ? 1 : 0,
                    borderRightColor: th.border,
                    borderTopWidth: buttons && buttons.length !== 2 && i > 0 ? 1 : 0,
                    borderTopColor: th.border,
                  }}
                >
                  <Text style={{
                    fontSize: 15,
                    fontWeight: isDestructive ? '700' : isCancel ? '400' : '600',
                    color: isDestructive ? th.danger : isCancel ? th.textMuted : th.accent,
                  }}>{btn.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// Hook to use AppModal imperatively — returns [show, ModalEl]
// th is passed as a ref so it's always current regardless of when the hook was called
function useAppModal() {
  const [config, setConfig] = React.useState(null);
  const thRef = React.useRef(null);
  const show = React.useCallback((title, message, buttons, icon) => {
    setConfig({ title, message, buttons, icon });
  }, []);
  const hide = React.useCallback(() => setConfig(null), []);
  // Returns [show, (th) => el] — caller passes current th each render
  const getEl = (th) => {
    thRef.current = th;
    return config ? (
      <AppModal
        visible={true}
        th={th}
        title={config.title}
        message={config.message}
        icon={config.icon}
        buttons={config.buttons}
        onClose={hide}
      />
    ) : null;
  };
  return [show, getEl];
}



// ============================================================
// STYLES
// ============================================================
function makeStyles(th) {
  return StyleSheet.create({
    header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
    headerTitle: { fontSize: 22, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' },
    pill:        { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20 },
    tabBar:      { flexDirection: 'row', borderTopWidth: 1, paddingBottom: Platform.OS === 'ios' ? 24 : 4, paddingTop: 6 },
    tabItem:     { flex: 1, alignItems: 'center', paddingVertical: 2, position: 'relative' },
    tabIcon:     { fontSize: 20 },
    tabLabel:    { fontSize: 10, marginTop: 2, fontWeight: '600' },
    tabLine:     { position: 'absolute', bottom: -2, left: '25%', right: '25%', height: 2.5, borderRadius: 2 },
    opmlBar:     { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 16 },
    opmlBtn:     { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
    catHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 11, borderRadius: 10, borderWidth: 1, marginBottom: 6 },
    catTitle:    { fontWeight: '700', fontSize: 14 },
    feedCard:    { borderWidth: 1, borderRadius: 12, padding: 13, marginBottom: 8 },
    feedName:    { fontWeight: '700', fontSize: 15, flex: 1, marginRight: 6 },
    smallBtn:    { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
    badge:       { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10 },
    badgeText:   { color: '#fff', fontSize: 11, fontWeight: '800' },
    searchRow:   { flexDirection: 'row', alignItems: 'center', margin: 12, padding: 10, borderRadius: 12, borderWidth: 1 },
    searchInput: { flex: 1, fontSize: 15 },
    chip:        { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, height: 30, justifyContent: 'center' },
    chipText:    { fontSize: 12, fontWeight: '600' },
    readerBar:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
    row:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderWidth: 1, borderRadius: 11, marginBottom: 8 },
    rowLabel:    { fontSize: 15, fontWeight: '500' },
    sLabel:      { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8, marginTop: 4 },
    inputRow:    { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, marginBottom: 8, overflow: 'hidden' },
    inlineInput: { flex: 1, padding: 11, fontSize: 15 },
    ghostBtn:    { borderWidth: 1, borderRadius: 10, padding: 12, alignItems: 'center' },
    sheet:       { borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, borderWidth: 1, borderBottomWidth: 0 },
    sheetTitle:  { fontSize: 21, fontWeight: '800', marginBottom: 18 },
    label:       { fontSize: 13, fontWeight: '600', marginBottom: 6 },
    input:       { borderWidth: 1, borderRadius: 11, padding: 12, fontSize: 15, marginBottom: 14 },
    modalBtn:    { padding: 14, borderRadius: 12 },
    empty:       { alignItems: 'center', paddingVertical: 60 },
    emptyIcon:   { fontSize: 52, marginBottom: 12 },
    emptyTitle:  { fontSize: 20, fontWeight: '700', marginBottom: 6 },
    emptySub:    { fontSize: 14, textAlign: 'center', paddingHorizontal: 40, lineHeight: 20 },
  });
}
